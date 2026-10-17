local POLL_MS = 500
local OWNER_REFRESH_TICKS = 4
local MAX_INBOX = 100
local MAX_BODY_BYTES = 262144
local MAX_RECORD_BYTES = MAX_BODY_BYTES + 4096
local NAME_HEX_WIDTH = 8
local OWNER_STALE_SECONDS = 15
local MESSAGE_TTL_SECONDS = 300
local PROTOCOL_VERSION = 1
local ORIGIN_HOST = "maki"
local NOT_LIVE_ERR = "session not live"

local runtime = {
  root = nil,
  sessions = {},
  dirty = {},
  current_session = nil,
  statuses = {},
  ticks = 0,
  read_ticks = 0,
  read_cursor = 0,
  last_poll_err = nil,
  read_pending = false,
  cwd = nil,
}

local function normalize_dir(path)
  if type(path) ~= "string" or path == "" then
    return nil
  end
  local trimmed = path:gsub("/+$", "")
  if trimmed == "" then
    return "/"
  end
  return trimmed
end

runtime.cwd = normalize_dir(maki.uv.cwd())

local function valid_id(id)
  return type(id) == "string" and #id <= 128 and id:match("^[%w_-]+$") ~= nil
end

local function same_dir(peer, mine)
  return mine ~= nil and mine.cwd ~= nil and type(peer.cwd) == "string" and normalize_dir(peer.cwd) == mine.cwd
end

local function host_of(peer)
  local origin = peer.origin
  if type(origin) == "table" and type(origin.host) == "string" then
    return origin.host
  end
  return ORIGIN_HOST
end

-- The id is the session's, because the session is what survives a reload: the
-- next process resumes it under the same storage id, so addresses held by
-- other agents keep working. One record per live session, like the opencode
-- half, whose ids are the same hash of the same thing.
local function peer_id_for(session_id)
  return "peer-" .. session_id
end

local function session_status(session_id)
  return runtime.statuses[session_id] or "idle"
end

local function path_join(...)
  return maki.fs.joinpath(...)
end

local function ensure_dir(path)
  local ok, err = maki.fs.mkdir(path, { parents = true })
  if ok then
    return true
  end
  local meta, meta_err = maki.fs.metadata(path)
  if meta and meta.is_dir then
    return true
  end
  return nil, err or meta_err or ("could not create directory: " .. path)
end

local function ensure_layout()
  if runtime.root then
    return true
  end
  local state, state_err = maki.env.state_dir()
  if not state then
    return nil, state_err or "maki state directory is unavailable"
  end
  local root = path_join(state, "peers")
  local ok, err = ensure_dir(path_join(root, "owners"))
  if not ok then
    return nil, err
  end
  ok, err = ensure_dir(path_join(root, "inboxes"))
  if not ok then
    return nil, err
  end
  runtime.root = root
  return true
end

local function owner_path(id)
  return path_join(runtime.root, "owners", id .. ".json")
end

local function inbox_path(id)
  return path_join(runtime.root, "inboxes", id)
end

local function read_json(path)
  local meta, meta_err = maki.fs.metadata(path)
  if not meta then
    return nil, meta_err
  end
  if not meta.is_file then
    return nil, "not a file: " .. path
  end
  if meta.size and meta.size > MAX_RECORD_BYTES then
    return nil, "record is too large: " .. path
  end
  local text, read_err = maki.fs.read(path)
  if not text then
    return nil, read_err
  end
  local value, decode_err = maki.json.decode(text)
  if value == nil then
    return nil, decode_err or "invalid JSON"
  end
  return value, nil
end

local function write_json(path, value)
  local encoded, encode_err = maki.json.encode(value)
  if not encoded then
    return nil, encode_err
  end
  local ok, write_err = maki.fs.atomic_write(path, encoded)
  if not ok then
    return nil, write_err
  end
  return true
end

local function remove_file(path)
  local ok, err = maki.fs.rm(path, { force = true })
  if not ok then
    return nil, err
  end
  return true
end

local MAX_TITLE_RUNES = 64
local MIN_ABBREV_CHARS = 4

-- Derived from the peer id, not the title: titles are free text, mutable and
-- not unique, so they cannot be an address. The opencode half derives its name
-- from its peer id the same way, so both records read as one rule.
local function peer_name(id)
  local rest = id:gsub("^peer%-", "")
  return "maki-" .. rest:sub(1, NAME_HEX_WIDTH)
end

-- A title is free text written by another agent, so it is treated as data and
-- never as markup: control characters go, whitespace collapses to one space,
-- and the cap lands on a rune boundary so a code point is never split.
local function sanitize_title(title)
  if type(title) ~= "string" then
    return nil
  end
  local text = title:gsub("%c", " "):gsub("%s+", " "):match("^%s*(.-)%s*$")
  if text == "" then
    return nil
  end
  local cut = utf8.offset(text, MAX_TITLE_RUNES + 1)
  if cut then
    text = text:sub(1, cut - 1)
  end
  return text
end

local function register_session(session_id)
  if runtime.sessions[session_id] then
    return
  end
  local record = {
    protocol = PROTOCOL_VERSION,
    id = peer_id_for(session_id),
    name = peer_name(peer_id_for(session_id)),
    started = os.time(),
    last_seen = os.time(),
    status = session_status(session_id),
  }
  -- Optional on purpose. Bumping PROTOCOL_VERSION would make an upgraded half
  -- invisible to a half that was not upgraded, since readers reject any record
  -- whose protocol is not theirs.
  if runtime.cwd then
    record.cwd = normalize_dir(runtime.cwd)
  end
  runtime.sessions[session_id] = record
  runtime.dirty[session_id] = true
end

-- A session that is gone takes its presence with it. On reload the inbox is
-- kept: the session resumes under the same id in the next process, and mail
-- queued for it should still be there when it does.
local function unregister_session(session_id, keep_inbox)
  local record = runtime.sessions[session_id]
  if not record then
    return
  end
  remove_file(owner_path(record.id))
  if not keep_inbox then
    maki.fs.rm(inbox_path(record.id), { recursive = true, force = true })
  end
  runtime.sessions[session_id] = nil
  runtime.dirty[session_id] = nil
  runtime.statuses[session_id] = nil
end

local function flush_session(session_id)
  local record = runtime.sessions[session_id]
  if not record then
    return true
  end
  record.last_seen = os.time()
  record.status = session_status(session_id)
  return write_json(owner_path(record.id), record)
end

-- Dirty records flush on the tick they changed on, the rest on the heartbeat
-- so last_seen keeps breathing. The heartbeat is not reset by a dirty flush,
-- or a session that changes every tick would never reach it.
local function flush_sessions()
  local due = runtime.ticks >= OWNER_REFRESH_TICKS
  if due then
    runtime.ticks = 0
  end
  for session_id in pairs(runtime.sessions) do
    if due or runtime.dirty[session_id] then
      runtime.dirty[session_id] = nil
      local written, write_err = flush_session(session_id)
      if not written then
        return nil, write_err
      end
    end
  end
  return true
end

-- The record of the session acting, created if this is its first action
-- before the heartbeat reached it. The write is synchronous on purpose: a
-- tool that lists or sends must find its own record on disk when it returns,
-- not one heartbeat later.
local function ensure_session(session_id)
  if not session_id then
    return nil, "no live session for this peer action"
  end
  local ok, err = ensure_layout()
  if not ok then
    return nil, err
  end
  register_session(session_id)
  local record = runtime.sessions[session_id]
  runtime.dirty[session_id] = nil
  local written, write_err = flush_session(session_id)
  if not written then
    return nil, write_err
  end
  return record
end

-- maki.session.read is the authority for status, title, working directory and
-- model of one session, and each live session carries its own record, so
-- peers see sessions, not processes. It is a UI roundtrip and answers only
-- when the loop drains UiAction between frames, and ui_roundtrip carries no
-- deadline on purpose because open_editor holds the loop for as long as it is
-- up. The refresh therefore runs in a spawned task that outlives its caller,
-- so a slow UI delays the record instead of the loop.
local function current_session()
  if runtime.current_session then
    return runtime.current_session
  end
  local id, err = maki.session.current()
  if id then
    runtime.current_session = id
    return id
  end
  return nil, err
end

local function refresh_one(session_id)
  local snapshot, read_err = maki.session.read({ session = session_id })
  if type(snapshot) ~= "table" then
    maki.log.warn("peer: session read failed: " .. tostring(read_err))
    return
  end
  local record = runtime.sessions[session_id]
  if not record then
    return
  end
  if snapshot.status == "idle" or snapshot.status == "working" or snapshot.status == "needs_input" then
    runtime.statuses[session_id] = snapshot.status
  end
  local dir = normalize_dir(snapshot.cwd)
  if dir and dir ~= record.cwd then
    record.cwd = dir
    runtime.dirty[session_id] = true
  end
  -- Assigning nil removes the key, which the encoder omits, so a cleared title
  -- stops being published rather than sticking to whatever was read first.
  local title = sanitize_title(snapshot.title)
  if title ~= record.title then
    record.title = title
    runtime.dirty[session_id] = true
  end
  if type(snapshot.model) == "string" and snapshot.model ~= record.model then
    record.model = snapshot.model
    runtime.dirty[session_id] = true
  end
end

-- The focused session is registered from the first event that names it, and
-- the current listing seeds it before the first event arrives. One read per
-- heartbeat, rotating through the known sessions, so a slow session delays
-- only its own record. One refresh in flight at a time: a task parked on a
-- busy loop would otherwise accumulate one per tick.
local function refresh_sessions()
  local focused = current_session()
  if focused then
    register_session(focused)
  end
  local ids = {}
  for session_id in pairs(runtime.sessions) do
    ids[#ids + 1] = session_id
  end
  table.sort(ids)
  if #ids == 0 then
    return
  end
  runtime.read_cursor = (runtime.read_cursor % #ids) + 1
  refresh_one(ids[runtime.read_cursor])
end

local function request_refresh()
  if runtime.read_pending then
    return
  end
  runtime.read_pending = true
  local started, start_err = maki.async.spawn(function()
    local ok, err = pcall(refresh_sessions)
    runtime.read_pending = false
    if not ok then
      maki.log.warn("peer refresh: " .. tostring(err))
    end
  end)
  if not started then
    runtime.read_pending = false
    maki.log.warn("peer refresh could not start: " .. tostring(start_err))
  end
end

local function owner_entries()
  local entries, err = maki.fs.dir(path_join(runtime.root, "owners"), { depth = 1 })
  if not entries then
    return nil, err
  end
  return entries
end

-- Every presence record on disk, live or stale, each carrying `age` in seconds.
-- Resolution needs stale records too, so it can say a peer may have exited
-- rather than pretending it never existed.
local function scan_owners()
  local entries, entries_err = owner_entries()
  if not entries then
    return nil, entries_err
  end
  local now = os.time()
  local peers = {}
  for _, entry in ipairs(entries) do
    local name, kind = entry[1], entry[2]
    if kind == "file" and name:match("%.json$") then
      local record = read_json(path_join(runtime.root, "owners", name))
      if
        type(record) == "table"
        and record.protocol == PROTOCOL_VERSION
        and valid_id(record.id)
        and tonumber(record.last_seen)
      then
        record.age = now - tonumber(record.last_seen)
        peers[#peers + 1] = record
      end
    end
  end
  table.sort(peers, function(a, b)
    return a.id < b.id
  end)
  return peers, nil
end

local function is_live(peer)
  return peer.age <= OWNER_STALE_SECONDS
end

local function list_peers()
  if not runtime.root then
    local ok, layout_err = ensure_layout()
    if not ok then
      return nil, layout_err
    end
  end
  local peers, scan_err = scan_owners()
  if not peers then
    return nil, scan_err
  end
  local live = {}
  for _, peer in ipairs(peers) do
    if is_live(peer) then
      live[#live + 1] = peer
    end
  end
  return live, nil
end

local function peer_label(peer)
  return string.format("%s [%s]", peer.name, peer.id)
end

local function peer_labels(peers)
  local parts = {}
  for _, peer in ipairs(peers) do
    parts[#parts + 1] = peer_label(peer)
  end
  return table.concat(parts, ", ")
end

-- Most specific match wins outright, so an exact id is never reported as
-- ambiguous just because another peer shares its prefix.
local function match_peers(query, peers)
  local by_id, by_name, by_name_suffix, by_id_prefix = {}, {}, {}, {}
  local lowered = query:lower()
  for _, peer in ipairs(peers) do
    if peer.id == query then
      by_id[#by_id + 1] = peer
    elseif peer.name == query then
      by_name[#by_name + 1] = peer
    elseif #lowered <= #peer.name and peer.name:lower():sub(-#lowered) == lowered then
      by_name_suffix[#by_name_suffix + 1] = peer
    elseif #lowered <= #peer.id and peer.id:lower():sub(1, #lowered) == lowered then
      by_id_prefix[#by_id_prefix + 1] = peer
    end
  end
  if #by_id > 0 then
    return by_id
  end
  if #by_name > 0 then
    return by_name
  end
  if #by_name_suffix > 0 then
    return by_name_suffix
  end
  return by_id_prefix
end

local function resolve_target(query, self_id)
  if type(query) ~= "string" or query:match("^%s*$") then
    return nil, "a peer name or id is required"
  end
  local peers, scan_err = scan_owners()
  if not peers then
    return nil, scan_err
  end
  -- The session that asked is not a target anywhere in this function. A send
  -- to yourself would only arrive back in your own session, and the suggestion
  -- list already refused to offer it, so matching has to agree with that. The
  -- other sessions of this process are ordinary peers.
  local others = {}
  for _, peer in ipairs(peers) do
    if peer.id ~= self_id then
      others[#others + 1] = peer
    end
  end
  local matches = match_peers(query, others)
  if #matches == 0 then
    local live = {}
    for _, peer in ipairs(others) do
      if is_live(peer) then
        live[#live + 1] = peer
      end
    end
    -- "live" is load bearing once the sweep horizon is longer than the stale
    -- window: after it, a peer that exited reads the same as one that never
    -- existed, and this must not claim to know which.
    if #live == 0 then
      return nil, string.format('no live peer matches "%s"; no other local peers are registered', query)
    end
    return nil, string.format('no live peer matches "%s"; pass one of: %s', query, peer_labels(live))
  end
  local live = {}
  for _, peer in ipairs(matches) do
    if is_live(peer) then
      live[#live + 1] = peer
    end
  end
  if #live == 1 then
    return live[1]
  end
  if #live > 1 then
    return nil, string.format('"%s" matches %d peers: %s', query, #live, peer_labels(live))
  end
  -- Nothing live matched, but something did. Asking the reader to
  -- disambiguate between peers that have all exited is not useful, so name the
  -- newest and say how many there were.
  table.sort(matches, function(a, b)
    return a.age < b.age
  end)
  local peer = matches[1]
  local many = ""
  if #matches > 1 then
    many = string.format(" (%d exited peers match, this is the newest)", #matches)
  end
  return nil, string.format("peer %s last refreshed %ds ago; it may have exited%s", peer_label(peer), peer.age, many)
end

local function new_message_id(owner_id, to)
  for _ = 1, 10 do
    local id = string.format("%s-%x-%x", owner_id, os.time(), math.random(0, 0x7fffffff))
    local path = path_join(inbox_path(to), id .. ".json")
    if not maki.fs.metadata(path) then
      return id
    end
  end
  return nil, "could not allocate a message id"
end

local function encode_body(body)
  if type(body) == "string" then
    if #body > MAX_BODY_BYTES then
      return nil, "message body is too large"
    end
    if body:match("^%s*$") then
      return nil, "message body is blank"
    end
    return body
  end
  local encoded, err = maki.json.encode(body)
  if not encoded then
    return nil, err
  end
  if #encoded > MAX_BODY_BYTES then
    return nil, "message body is too large"
  end
  return encoded
end

local function queue_message(owner, target, body, opts)
  opts = opts or {}
  local encoded_body, body_err = encode_body(body)
  if not encoded_body then
    return nil, body_err
  end
  local kind = opts.kind or "observation"
  if kind ~= "observation" and kind ~= "status" then
    return nil, "kind must be observation or status"
  end
  local ttl = tonumber(opts.ttl_seconds) or MESSAGE_TTL_SECONDS
  ttl = math.max(1, math.min(math.floor(ttl), MESSAGE_TTL_SECONDS))
  local message_id = opts.id
  if message_id and not valid_id(message_id) then
    return nil, "invalid message id"
  end
  if not message_id then
    local generated, id_err = new_message_id(owner.id, target.id)
    if not generated then
      return nil, id_err
    end
    message_id = generated
  end
  local inbox = inbox_path(target.id)
  local ok, dir_err = ensure_dir(inbox)
  if not ok then
    return nil, dir_err
  end
  local path = path_join(inbox, message_id .. ".json")
  local meta = maki.fs.metadata(path)
  if meta then
    return { id = message_id, peer_id = target.id, state = "duplicate" }
  end
  local message = {
    protocol = PROTOCOL_VERSION,
    id = message_id,
    from = owner.id,
    from_name = owner.name,
    to = target.id,
    kind = kind,
    body = encoded_body,
    session = opts.session,
    origin = { host = ORIGIN_HOST },
    created = os.time(),
    expires = os.time() + ttl,
  }
  local written, write_err = write_json(path, message)
  if not written then
    return nil, write_err
  end
  return { id = message_id, peer_id = target.id, state = "queued" }
end

-- `query` is a peer name, a peer id, or any suffix or prefix of either, so it
-- is resolved against the presence records rather than validated as an id.
local function send_message(query, body, opts, self_session_id)
  opts = opts or {}
  local mine, self_err = ensure_session(self_session_id)
  if not mine then
    return nil, self_err
  end
  local target, resolve_err = resolve_target(query, mine.id)
  if not target then
    return nil, resolve_err
  end
  return queue_message(mine, target, body, opts)
end

local function broadcast_message(body, opts, self_session_id)
  opts = opts or {}
  local mine, self_err = ensure_session(self_session_id)
  if not mine then
    return nil, self_err
  end
  local peers, list_err = list_peers()
  if not peers then
    return nil, list_err
  end
  local same_dir_only = opts.same_dir_only == true
  local receipts = {}
  for _, peer in ipairs(peers) do
    if peer.id ~= mine.id and (not same_dir_only or same_dir(peer, mine)) then
      local receipt, err = queue_message(mine, peer, body, opts)
      receipts[#receipts + 1] = receipt or { peer_id = peer.id, state = "rejected", error = err }
    end
  end
  return receipts, nil
end

local function valid_message(message, owner_id)
  return type(message) == "table"
    and message.protocol == PROTOCOL_VERSION
    and message.to == owner_id
    and type(message.from) == "string"
    and type(message.from_name) == "string"
    and type(message.body) == "string"
    and type(message.id) == "string"
    and (message.session == nil or type(message.session) == "string")
end

-- One string, mirrored byte for byte by the opencode half, so a reader can map
-- the prefix back to a name without consulting peer_list.
local function delivery_text(message)
  return string.format("[peer %s %s] %s", message.from_name, message.from, message.body)
end

-- A session id only means something to the host that minted it. An id from
-- another host cannot name a session here, so honour it only for our own.
local function message_session(message)
  local origin = message.origin
  if type(origin) == "table" and type(origin.host) == "string" and origin.host ~= ORIGIN_HOST then
    return nil
  end
  return message.session
end

-- An unaddressed message sits in the inbox of the session it was sent to, so
-- that session is the target; it may not be live right now, but sessions
-- resume under the same id, so retry rather than drop.
local function deliver_message(path, message, inbox_session_id)
  local target = message_session(message)
  local addressed = target ~= nil
  if not target then
    target = inbox_session_id
  end
  if not target then
    return "retry", "no live session for peer message"
  end
  local text = delivery_text(message)
  local delivered, notify_err = maki.session.notify(text, {
    session = target,
    wake = message.wake == true,
  })
  if not delivered then
    if addressed and type(notify_err) == "string" and notify_err:sub(1, #NOT_LIVE_ERR) == NOT_LIVE_ERR then
      return "dead", notify_err
    end
    return "retry", notify_err
  end
  local removed, remove_err = remove_file(path)
  if not removed then
    maki.log.error("peer: delivered " .. message.id .. " but could not remove it: " .. tostring(remove_err))
  end
  return "delivered", nil
end

-- A record we can read but cannot use is never going to become deliverable:
-- both writers are atomic, so neither half produces a torn record, and a
-- misfiled record cannot be delivered by any poller. Leaving it would re-read
-- and re-warn on every pass forever. A failed read is different, since that
-- may be transient, so the read failure is handled before this runs.
local function drop_undeliverable(name, path, why)
  maki.log.warn("peer: dropped undeliverable message " .. name .. ": " .. tostring(why))
  remove_file(path)
end

local function receive_inbox(session_id, record)
  local inbox = inbox_path(record.id)
  local ok, dir_err = ensure_dir(inbox)
  if not ok then
    return nil, dir_err
  end
  local entries, entries_err = maki.fs.dir(inbox, { depth = 1 })
  if not entries then
    return nil, entries_err
  end
  local pending = {}
  local now = os.time()
  for _, entry in ipairs(entries) do
    local name, kind = entry[1], entry[2]
    if kind == "file" and name:match("%.json$") then
      local path = path_join(inbox, name)
      -- One read, then decode those bytes. Reading twice would let a delete
      -- land between the two and turn a good message into an undeliverable one.
      local meta = maki.fs.metadata(path)
      if not meta or not meta.is_file then
        maki.log.warn("peer: could not stat " .. name)
      elseif meta.size and meta.size > MAX_RECORD_BYTES then
        drop_undeliverable(name, path, "record is too large")
      else
        local text, read_err = maki.fs.read(path)
        if not text then
          maki.log.warn("peer: could not read " .. name .. ": " .. tostring(read_err))
        else
          local message = maki.json.decode(text)
          if not valid_message(message, record.id) then
            drop_undeliverable(name, path, "unparsable or misfiled")
          elseif tonumber(message.expires) and tonumber(message.expires) <= now then
            remove_file(path)
          else
            pending[#pending + 1] = { path = path, value = message }
          end
        end
      end
    end
  end
  table.sort(pending, function(a, b)
    return (a.value.created or 0) < (b.value.created or 0)
  end)
  local overflow = #pending - MAX_INBOX
  if overflow > 0 then
    maki.log.warn("peer: " .. overflow .. " messages waited behind the inbox cap this cycle")
  end
  local delivery_errors = {}
  for index = 1, math.min(#pending, MAX_INBOX) do
    local item = pending[index]
    local state, deliver_err = deliver_message(item.path, item.value, session_id)
    if state == "delivered" then
      maki.api.exec_autocmds("PeerMessage", {
        pattern = item.value.from,
        data = { message = item.value, receipt = { state = "delivered" } },
      })
    elseif state == "dead" then
      maki.log.warn("peer: dropped " .. item.value.id .. " for " .. record.id .. ": " .. tostring(deliver_err))
      remove_file(item.path)
    elseif deliver_err then
      delivery_errors[#delivery_errors + 1] = deliver_err
    end
  end
  if #delivery_errors > 0 then
    return nil, table.concat(delivery_errors, "; ")
  end
  return true
end

-- Each live session reads its own inbox, so mail lands on the session it was
-- addressed to even while another session of this process is focused.
local function receive_messages()
  local failed = nil
  for session_id, record in pairs(runtime.sessions) do
    local ok, err = receive_inbox(session_id, record)
    if not ok and not failed then
      failed = err
    end
  end
  if failed then
    return nil, failed
  end
  return true
end

local function poll()
  -- The body runs inside a pcall and the next tick is scheduled after it, so
  -- a slow delivery cannot start a second poll on top of this one. Two
  -- overlapping polls would both read the same inbox and deliver twice, which
  -- is exactly what the opencode half hit in the field.
  local ok, err = pcall(function()
    local laid, layout_err = ensure_layout()
    if not laid then
      maki.log.warn("peer layout: " .. layout_err)
      return
    end
    runtime.ticks = runtime.ticks + 1
    -- Flush before refreshing. A refresh sets fields on records, and it
    -- cannot set a field on a record that does not exist yet, so the other
    -- order would silently drop whatever the first refresh learned.
    local _, flush_err = flush_sessions()
    if flush_err then
      maki.log.warn("peer flush: " .. flush_err)
    end
    runtime.read_ticks = runtime.read_ticks + 1
    if runtime.read_ticks >= OWNER_REFRESH_TICKS then
      runtime.read_ticks = 0
      request_refresh()
    end
    local _, receive_err = receive_messages()
    if receive_err then
      maki.log.warn("peer inbox: " .. receive_err)
    end
  end)
  -- Warn on a poll failure, but once per distinct message. A failure that
  -- persists is the same line twice a second, and a log nobody can read is its
  -- own kind of silence. A new failure still warns at once, and recovery clears
  -- it so a recurrence is not swallowed by the last one.
  if not ok then
    local msg = tostring(err)
    if msg ~= runtime.last_poll_err then
      runtime.last_poll_err = msg
      maki.log.warn("peer poll: " .. msg)
    end
  else
    runtime.last_poll_err = nil
  end
  maki.defer_fn(poll, POLL_MS)
end

local function register_status_autocmds()
  -- A session becomes a peer on the first event that names it, the same rule
  -- the opencode half follows, and unregistering is SessionEnd's job.
  maki.api.create_autocmd("SessionStatusChanged", {
    callback = function(ev)
      runtime.statuses[ev.data.session_id] = ev.data.status
      register_session(ev.data.session_id)
      runtime.dirty[ev.data.session_id] = true
    end,
  })
  maki.api.create_autocmd("SessionFocusChanged", {
    callback = function(ev)
      runtime.current_session = ev.data.session_id
      register_session(ev.data.session_id)
      runtime.dirty[ev.data.session_id] = true
    end,
  })
  maki.api.create_autocmd("ModelChanged", {
    callback = function(ev)
      local data = ev.data or {}
      local session_id = data.session_id or runtime.current_session
      local record = session_id and runtime.sessions[session_id]
      if record and type(data.model) == "table" and type(data.model.spec) == "string" then
        record.model = data.model.spec
        runtime.dirty[session_id] = true
      end
    end,
  })
  maki.api.create_autocmd("SessionEnd", {
    callback = function(ev)
      local session_id = ev.data.session_id
      runtime.statuses[session_id] = nil
      if runtime.current_session == session_id then
        runtime.current_session = nil
      end
      unregister_session(session_id, ev.data.reason == "reload")
    end,
  })
end

local function common_prefix_len(a, b)
  if not a or not b then
    return 0
  end
  local common = 0
  while
    common < #a
    and common < #b
    and a:sub(common + 1, common + 1) == b:sub(common + 1, common + 1)
  do
    common = common + 1
  end
  return common
end

-- Like git abbreviating hashes: the shortest prefix of each id that still
-- separates it from every other live peer, never below MIN_ABBREV_CHARS.
-- Resolution accepts any unambiguous prefix, so a shortened list line stays a
-- valid handle, and an exited peer that shares the prefix cannot block a
-- match because live matches win.
local function abbreviate_ids(peers)
  local sorted = {}
  for index, peer in ipairs(peers) do
    sorted[index] = peer.id
  end
  table.sort(sorted)
  local widths = {}
  for index, id in ipairs(sorted) do
    local shared = math.max(common_prefix_len(id, sorted[index - 1]), common_prefix_len(id, sorted[index + 1]))
    local width = shared + 1
    if width < MIN_ABBREV_CHARS then
      width = MIN_ABBREV_CHARS
    end
    if width > #id then
      width = #id
    end
    widths[id] = width
  end
  return widths
end

local function peer_list_lines(self_session_id)
  local mine, mine_err = ensure_session(self_session_id)
  if not mine then
    return nil, mine_err
  end
  local peers, err = list_peers()
  if not peers then
    return nil, err
  end
  local widths = abbreviate_ids(peers)
  local lines = {}
  for _, peer in ipairs(peers) do
    local line = string.format(
      "- %s  %s  %s  %s  %s  via %s",
      peer.id:sub(1, widths[peer.id] or #peer.id),
      peer.status,
      peer.model or "-",
      peer.name,
      peer.title or "-",
      host_of(peer)
    )
    if peer.id == mine.id then
      line = line .. "  (you)"
    end
    if host_of(peer) == ORIGIN_HOST then
      line = line .. "  (local)"
    end
    if same_dir(peer, mine) then
      line = line .. "  (same dir)"
    end
    lines[#lines + 1] = line
  end
  if #lines == 0 then
    lines[1] = "No other local peers are registered."
  end
  return lines, nil
end

local function peer_list_output(self_session_id)
  local lines, err = peer_list_lines(self_session_id)
  if not lines then
    return nil, err
  end
  return table.concat(lines, "\n")
end

local PEER_WINDOW_MARGIN = 4

-- A notice renders one line in the status bar, so the list goes into a float
-- instead and the command waits in recv until the user dismisses it.
local function show_peers()
  local lines, err = peer_list_lines(current_session())
  if not lines then
    maki.notify(err or "could not list peers", "error", { title = "peer" })
    return
  end
  local width = 0
  for _, line in ipairs(lines) do
    width = math.max(width, maki.ui.display_width(line))
  end
  local cols = maki.ui.terminal_size().cols
  local buf = maki.ui.buf({ scratch = true })
  buf:lines(lines)
  local win = maki.ui.open_win(buf, {
    title = " Peers ",
    width = math.min(width + PEER_WINDOW_MARGIN, cols - PEER_WINDOW_MARGIN),
    height = #lines + 2,
    border = "rounded",
    focus = true,
    footer = { { "Esc", "close" } },
  })
  while true do
    local ev = win:recv()
    if not ev or ev.type == "close" or (ev.type == "key" and ev.key == "<Esc>") then
      break
    end
  end
  win:close()
end

local function start_peer(launcher, prompt, model, self_session_id)
  if type(prompt) ~= "string" or prompt:match("^%s*$") then
    return nil, "a non-blank prompt is required"
  end
  if model ~= nil then
    if type(model) ~= "string" or model:match("^%s*$") then
      return nil, "model must be a non-blank provider/model-id spec"
    end
    local slug = model:match("^(%S+)/%S+$")
    if not slug then
      return nil, "model must look like provider/model-id, for example zai/glm-5.3-flash"
    end
    local info, info_err = maki.model.info(model)
    if not info then
      return nil, "model " .. model .. " did not resolve: " .. tostring(info_err)
    end
  end
  if launcher ~= "tmux" then
    return nil, "only the tmux launcher is available in this build"
  end
  local mine, self_err = ensure_session(self_session_id)
  if not mine then
    return nil, self_err
  end
  local suffix = mine.id:sub(1, 8)
  local name = "maki-peer-" .. suffix .. "-" .. tostring(os.time())
  local argv = { "tmux", "new-session", "-d", "-s", name, "maki" }
  if model then
    argv[#argv + 1] = "--model"
    argv[#argv + 1] = model
  end
  argv[#argv + 1] = prompt
  local ok, job, spawn_err = pcall(maki.fn.jobstart, argv, {
    scope = "plugin",
    name = "peer-spawn-" .. name,
    on_exit = function(_, code)
      if code ~= 0 then
        maki.notify("The tmux peer launcher exited with code " .. tostring(code) .. ".", "error", { title = "peer" })
      end
    end,
  })
  if not ok then
    return nil, tostring(job)
  end
  if not job then
    return nil, spawn_err or "the tmux launcher did not start"
  end
  return name, nil
end

maki.api.register_prompt_hint({
  slot = "tool_usage",
  content = "- Use peer_list to discover local Maki instances, peer_send to send an observation, peer_broadcast to reach every peer, and peer_spawn to start an independent tmux peer, optionally on a chosen model spec.",
})

maki.api.register_tool({
  name = "peer_list",
  kind = "other",
  description = "List Maki instances registered on this local machine.",
  schema = {
    type = "object",
    properties = {},
  },
  permission = "fs_read",
  permission_scopes = function()
    return { scopes = { "peer_list" }, force_prompt = false }
  end,
  handler = function(_, ctx)
    local output, err = peer_list_output(ctx and ctx:session_id())
    if not output then
      return { llm_output = err or "could not list peers", is_error = true }
    end
    return output
  end,
})

maki.api.register_tool({
  name = "peer_send",
  kind = "other",
  description = "Send an observation or status to another Maki instance on this local machine.",
  schema = {
    type = "object",
    properties = {
      peer_id = {
        type = "string",
        description = "Target peer id, name, or any suffix or prefix of either",
        required = true,
      },
      message = { type = "string", description = "Observation to deliver", required = true },
      session = { type = "string", description = "Optional target session id" },
      kind = { type = "string", description = "observation or status" },
    },
  },
  handler = function(input, ctx)
    local receipt, err = send_message(input.peer_id, input.message, {
      session = input.session,
      kind = input.kind,
    }, ctx and ctx:session_id())
    if not receipt then
      return { llm_output = err or "peer message was rejected", is_error = true }
    end
    return string.format("Queued peer message %s for %s.", receipt.id, receipt.peer_id)
  end,
})

maki.api.register_tool({
  name = "peer_broadcast",
  kind = "other",
  description = "Send an observation to every active local Maki instance.",
  schema = {
    type = "object",
    properties = {
      message = { type = "string", description = "Observation to deliver", required = true },
      session = { type = "string", description = "Optional target session id" },
      kind = { type = "string", description = "observation or status" },
      same_dir_only = { type = "boolean", description = "Only peers reporting the same working directory" },
    },
  },
  handler = function(input, ctx)
    local receipts, err = broadcast_message(input.message, {
      session = input.session,
      kind = input.kind,
      same_dir_only = input.same_dir_only,
    }, ctx and ctx:session_id())
    if not receipts then
      return { llm_output = err or "peer broadcast failed", is_error = true }
    end
    return "Queued " .. tostring(#receipts) .. " peer messages."
  end,
})

maki.api.register_tool({
  name = "peer_spawn",
  kind = "execute",
  description = "Spawn an independent Maki peer in a detached tmux session, optionally on a chosen model.",
  schema = {
    type = "object",
    properties = {
      launcher = { type = "string", description = "Launcher to use, currently tmux" },
      model = { type = "string", description = "Model spec provider/model-id for the peer, e.g. zai/glm-5.3-flash" },
      prompt = { type = "string", description = "Initial task for the peer", required = true },
    },
  },
  permission = "run",
  permission_scopes = function(input)
    return { scopes = { input.launcher or "tmux" }, force_prompt = true }
  end,
  handler = function(input, ctx)
    local name, err = start_peer(input.launcher or "tmux", input.prompt, input.model, ctx and ctx:session_id())
    if not name then
      return { llm_output = err or "peer spawn failed", is_error = true }
    end
    local model_note = input.model and (" on " .. input.model) or ""
    return "Spawned tmux peer session " .. name .. model_note .. "; it will register shortly."
  end,
})

maki.api.register_command({
  name = "/peer",
  description = "List local Maki peers or manage peer messages",
  nargs = "*",
  handler = function(opts)
    local args = opts.args or ""
    local subcommand, rest = args:match("^(%S+)%s*(.*)$")
    if not subcommand then
      show_peers()
      return
    end
    if subcommand == "list" then
      show_peers()
    elseif subcommand == "send" then
      local peer, message = rest:match("^(%S+)%s+(.+)$")
      if not peer then
        maki.notify("Usage: /peer send <peer> <message>", "warn", { title = "peer" })
        return
      end
      local receipt, err = send_message(peer, message, {}, current_session())
      if not receipt then
        maki.notify("Could not send peer message: " .. (err or "unknown error"), "error", { title = "peer" })
        return
      end
      maki.notify("Queued peer message " .. receipt.id .. " for " .. receipt.peer_id .. ".", "info", { title = "peer" })
    elseif subcommand == "spawn" then
      local model, prompt = rest:match("^%-%-model%s+(%S+)%s*(.*)$")
      if not model then
        prompt = rest
      end
      local without_tmux = prompt:match("^tmux%s+(.+)$")
      if without_tmux then
        prompt = without_tmux
      end
      local name, err = start_peer("tmux", prompt, model, current_session())
      if not name then
        maki.notify("Could not spawn peer: " .. (err or "unknown error"), "error", { title = "peer" })
        return
      end
      local model_note = model and (" on " .. model) or ""
      maki.notify(
        "Spawned tmux peer session " .. name .. model_note .. "; it will register shortly.",
        "info",
        { title = "peer" }
      )
    else
      maki.notify(
        "Usage: /peer [list|send <peer> <message>|spawn [--model <provider/model-id>] [tmux] <prompt>]",
        "warn",
        { title = "peer" }
      )
    end
  end,
})

register_status_autocmds()
maki.defer_fn(poll, 0)
