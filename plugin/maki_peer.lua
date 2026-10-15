local POLL_MS = 500
local MAX_INBOX = 100
local MAX_BODY_BYTES = 262144
local MAX_RECORD_BYTES = MAX_BODY_BYTES + 4096
local OWNER_STALE_SECONDS = 10
local MESSAGE_TTL_SECONDS = 300
local PROTOCOL_VERSION = 1

local runtime = {
  root = nil,
  peer_id = nil,
  owner = nil,
  current_session = nil,
  statuses = {},
}

local function valid_id(id)
  return type(id) == "string" and #id <= 128 and id:match("^[%w_-]+$") ~= nil
end

local function new_peer_id()
  return string.format("peer-%x-%x-%x", os.time(), math.floor(os.clock() * 1000000), math.random(0, 0x7fffffff))
end

local function status_now()
  local aggregate = "idle"
  for _, status in pairs(runtime.statuses) do
    if status == "needs_input" then
      return "needs_input"
    end
    if status == "working" then
      aggregate = "working"
    end
  end
  return aggregate
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
  runtime.peer_id = new_peer_id()
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

local function new_owner()
  return {
    protocol = PROTOCOL_VERSION,
    id = runtime.peer_id,
    name = "maki-" .. runtime.peer_id:sub(1, 13),
    started = os.time(),
    last_seen = os.time(),
    status = status_now(),
  }
end

local function set_owner_model(spec)
  local owner = runtime.owner
  if not owner or owner.model == spec then
    return
  end
  owner.model = spec
  write_json(owner_path(owner.id), owner)
end

local function report_model()
  maki.async.run(function()
    local state = maki.model.get()
    local spec = nil
    if type(state) == "table" and type(state.spec) == "string" then
      spec = state.spec
    end
    set_owner_model(spec)
  end)
end

local function ensure_registered()
  local ok, err = ensure_layout()
  if not ok then
    return nil, err
  end
  if not runtime.owner then
    for _ = 1, 10 do
      runtime.peer_id = new_peer_id()
      if not maki.fs.metadata(owner_path(runtime.peer_id)) then
        break
      end
    end
    if maki.fs.metadata(owner_path(runtime.peer_id)) then
      return nil, "could not allocate a peer id"
    end
    runtime.owner = new_owner()
    report_model()
  end
  local path = owner_path(runtime.peer_id)
  runtime.owner.last_seen = os.time()
  runtime.owner.status = status_now()
  local written, write_err = write_json(path, runtime.owner)
  if not written then
    return nil, write_err
  end
  return runtime.owner
end

local function owner_entries()
  local entries, err = maki.fs.dir(path_join(runtime.root, "owners"), { depth = 1 })
  if not entries then
    return nil, err
  end
  return entries
end

local function list_peers()
  local owner, owner_err = ensure_registered()
  if not owner then
    return nil, owner_err
  end
  local entries, entries_err = owner_entries()
  if not entries then
    return nil, entries_err
  end
  local now = os.time()
  local peers = {}
  for _, entry in ipairs(entries) do
    local name, kind = entry[1], entry[2]
    if kind == "file" and name:match("%.json$") then
      local record, read_err = read_json(path_join(runtime.root, "owners", name))
      if
        record
        and not read_err
        and record.protocol == PROTOCOL_VERSION
        and valid_id(record.id)
        and tonumber(record.last_seen)
        and now - tonumber(record.last_seen) <= OWNER_STALE_SECONDS
      then
        peers[#peers + 1] = record
      end
    end
  end
  table.sort(peers, function(a, b)
    return a.id < b.id
  end)
  return peers, nil
end

local function new_message_id(to)
  for _ = 1, 10 do
    local id = string.format("%s-%x-%x", runtime.peer_id, os.time(), math.random(0, 0x7fffffff))
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

local function send_message(to, body, opts)
  opts = opts or {}
  if not valid_id(to) then
    return nil, "invalid peer id"
  end
  local owner, owner_err = ensure_registered()
  if not owner then
    return nil, owner_err
  end
  local peers, list_err = list_peers()
  if not peers then
    return nil, list_err
  end
  local target
  for _, peer in ipairs(peers) do
    if peer.id == to then
      target = peer
      break
    end
  end
  if not target then
    return nil, "peer is not registered or is offline"
  end
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
    local generated, id_err = new_message_id(to)
    if not generated then
      return nil, id_err
    end
    message_id = generated
  end
  local inbox = inbox_path(to)
  local ok, dir_err = ensure_dir(inbox)
  if not ok then
    return nil, dir_err
  end
  local path = path_join(inbox, message_id .. ".json")
  local meta = maki.fs.metadata(path)
  if meta then
    return { id = message_id, peer_id = to, state = "duplicate" }
  end
  local message = {
    protocol = PROTOCOL_VERSION,
    id = message_id,
    from = owner.id,
    from_name = owner.name,
    to = to,
    kind = kind,
    body = encoded_body,
    session = opts.session,
    created = os.time(),
    expires = os.time() + ttl,
  }
  local written, write_err = write_json(path, message)
  if not written then
    return nil, write_err
  end
  return { id = message_id, peer_id = to, state = "queued" }
end

local function broadcast_message(body, opts)
  local peers, list_err = list_peers()
  if not peers then
    return nil, list_err
  end
  local owner, owner_err = ensure_registered()
  if not owner then
    return nil, owner_err
  end
  local receipts = {}
  for _, peer in ipairs(peers) do
    if peer.id ~= owner.id then
      local receipt, err = send_message(peer.id, body, opts)
      receipts[#receipts + 1] = receipt or { peer_id = peer.id, state = "rejected", error = err }
    end
  end
  return receipts, nil
end

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

local function deliver_message(path, message)
  local target = message.session
  if not target then
    target = current_session()
  end
  if not target then
    return nil, "no live session for peer message"
  end
  local text = string.format("[peer %s] %s", message.from, message.body)
  local delivered, notify_err = maki.session.notify(text, {
    session = target,
    wake = message.wake == true,
  })
  if not delivered then
    return nil, notify_err
  end
  local removed, remove_err = remove_file(path)
  if not removed then
    return nil, remove_err
  end
  return { message = message, receipt = { state = "delivered" } }
end

local function receive_messages()
  local owner, owner_err = ensure_registered()
  if not owner then
    return nil, owner_err
  end
  local inbox = inbox_path(owner.id)
  local ok, dir_err = ensure_dir(inbox)
  if not ok then
    return nil, dir_err
  end
  local entries, entries_err = maki.fs.dir(inbox, { depth = 1 })
  if not entries then
    return nil, entries_err
  end
  local messages = {}
  local delivery_errors = {}
  local now = os.time()
  for _, entry in ipairs(entries) do
    local name, kind = entry[1], entry[2]
    if kind == "file" and name:match("%.json$") then
      local path = path_join(inbox, name)
      local message, read_err = read_json(path)
      if message and not read_err then
        if
          message.protocol ~= PROTOCOL_VERSION
          or message.to ~= owner.id
          or type(message.from) ~= "string"
          or type(message.body) ~= "string"
          or type(message.id) ~= "string"
          or (message.session ~= nil and type(message.session) ~= "string")
        then
          maki.log.warn("peer: ignored invalid message " .. name)
        elseif tonumber(message.expires) and tonumber(message.expires) <= now then
          remove_file(path)
        else
          messages[#messages + 1] = { path = path, value = message }
        end
      end
    end
  end
  table.sort(messages, function(a, b)
    return (a.value.created or 0) < (b.value.created or 0)
  end)
  for index = 1, math.min(#messages, MAX_INBOX) do
    local item = messages[index]
    local delivered, deliver_err = deliver_message(item.path, item.value)
    if delivered then
      maki.api.exec_autocmds("PeerMessage", {
        pattern = item.value.from,
        data = delivered,
      })
    elseif deliver_err then
      delivery_errors[#delivery_errors + 1] = deliver_err
    end
  end
  if #delivery_errors > 0 then
    return nil, table.concat(delivery_errors, "; ")
  end
  return true
end

local function poll()
  maki.defer_fn(poll, POLL_MS)
  local owner, owner_err = ensure_registered()
  if not owner then
    maki.log.warn("peer registration: " .. owner_err)
    return
  end
  local _, receive_err = receive_messages()
  if receive_err then
    maki.log.warn("peer inbox: " .. receive_err)
  end
end

local function register_status_autocmds()
  maki.api.create_autocmd("SessionStatusChanged", {
    callback = function(ev)
      runtime.statuses[ev.data.session_id] = ev.data.status
      runtime.current_session = ev.data.session_id
      local owner = runtime.owner
      if owner then
        owner.status = status_now()
        owner.last_seen = os.time()
        write_json(owner_path(owner.id), owner)
      end
    end,
  })
  maki.api.create_autocmd("SessionFocusChanged", {
    callback = function(ev)
      runtime.current_session = ev.data.session_id
    end,
  })
  maki.api.create_autocmd("ModelChanged", {
    callback = function(ev)
      local model = ev.data and ev.data.model
      if type(model) == "table" and type(model.spec) == "string" then
        set_owner_model(model.spec)
      end
    end,
  })
  maki.api.create_autocmd("SessionEnd", {
    callback = function(ev)
      runtime.statuses[ev.data.session_id] = nil
      local owner = runtime.owner
      if not owner then
        return
      end
      local reason = ev.data.reason
      if reason == "shutdown" or reason == "reload" or reason == "completed" or reason == "replaced" then
        remove_file(owner_path(owner.id))
        runtime.owner = nil
        return
      end
      owner.status = status_now()
      owner.last_seen = os.time()
      write_json(owner_path(owner.id), owner)
    end,
  })
end

local function peer_list_output()
  local peers, err = list_peers()
  if not peers then
    return nil, err
  end
  local owner = runtime.owner
  local lines = {}
  if owner then
    lines[#lines + 1] =
      string.format("Local peer: %s (%s)%s", owner.name, owner.id, owner.model and (" " .. owner.model) or "")
  end
  for _, peer in ipairs(peers) do
    if not owner or peer.id ~= owner.id then
      lines[#lines + 1] =
        string.format("- %s [%s] %s%s", peer.name, peer.id, peer.status, peer.model and (" " .. peer.model) or "")
    end
  end
  if #lines <= 1 then
    lines[#lines + 1] = "No other local Maki instances are registered."
  end
  return table.concat(lines, "\n")
end

local function start_peer(launcher, prompt, model)
  if launcher ~= "tmux" then
    return nil, "only the tmux launcher is available in this build"
  end
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
  local owner, owner_err = ensure_registered()
  if not owner then
    return nil, owner_err
  end
  local suffix = owner.id:sub(1, 8)
  local name = "maki-peer-" .. suffix .. "-" .. tostring(os.time())
  local argv = { "tmux", "new-session", "-d", "-s", name, "maki" }
  if model then
    argv[#argv + 1] = "--model"
    argv[#argv + 1] = model
  end
  argv[#argv + 1] = prompt
  local ok, job_or_err = pcall(maki.fn.jobstart, argv, {
    scope = "plugin",
    name = "peer-spawn-" .. name,
    on_exit = function(_, code)
      if code ~= 0 then
        maki.notify("The tmux peer launcher exited with code " .. tostring(code) .. ".", "error", { title = "peer" })
      end
    end,
  })
  if not ok then
    return nil, tostring(job_or_err)
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
  handler = function()
    local output, err = peer_list_output()
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
      peer_id = { type = "string", description = "Target local peer id", required = true },
      message = { type = "string", description = "Observation to deliver", required = true },
      session = { type = "string", description = "Optional target session id" },
      kind = { type = "string", description = "observation or status" },
    },
  },
  handler = function(input)
    local receipt, err = send_message(input.peer_id, input.message, {
      session = input.session,
      kind = input.kind,
    })
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
    },
  },
  handler = function(input)
    local receipts, err = broadcast_message(input.message, {
      session = input.session,
      kind = input.kind,
    })
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
  handler = function(input)
    local name, err = start_peer(input.launcher or "tmux", input.prompt, input.model)
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
      local output, err = peer_list_output()
      maki.notify(output or err or "could not list peers", err and "error" or "info", { title = "peer" })
      return
    end
    if subcommand == "list" then
      local output, err = peer_list_output()
      maki.notify(output or err or "could not list peers", err and "error" or "info", { title = "peer" })
    elseif subcommand == "send" then
      local peer_id, message = rest:match("^(%S+)%s+(.+)$")
      if not peer_id then
        maki.notify("Usage: /peer send <peer-id> <message>", "warn", { title = "peer" })
        return
      end
      local receipt, err = send_message(peer_id, message, {})
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
      local name, err = start_peer("tmux", prompt, model)
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
        "Usage: /peer [list|send <peer-id> <message>|spawn [--model <provider/model-id>] [tmux] <prompt>]",
        "warn",
        { title = "peer" }
      )
    end
  end,
})

register_status_autocmds()
maki.defer_fn(poll, 0)
