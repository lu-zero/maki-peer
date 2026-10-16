use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod common;

use maki_agent::SessionMailbox;
use maki_agent::tools::ToolRegistry;
use maki_lua::{ModelRequest, PluginHost, PluginPermissions, UiAction};
use maki_storage::id::MakiId;
use serde_json::json;

const PLUGIN_NAME: &str = "maki-peer";
const MODEL_SPEC: &str = "zai/glm-5.3-flash";

fn plugin_host(root: &Path) -> (Arc<ToolRegistry>, PluginHost) {
    let registry = Arc::new(ToolRegistry::new());
    let host = PluginHost::new(Arc::clone(&registry)).unwrap();
    host.load_package(
        PLUGIN_NAME,
        root,
        PluginPermissions::trusted(),
        Default::default(),
    )
    .unwrap();
    (registry, host)
}

/// Answer `maki.model.get` roundtrips the way the UI event loop would, and
/// forward every other action for the assertions to observe.
fn serve_ui_actions(rx: flume::Receiver<UiAction>) -> mpsc::Receiver<UiAction> {
    let (forward_tx, forward_rx) = mpsc::channel();
    std::thread::spawn(move || {
        while let Ok(action) = rx.recv() {
            match action {
                UiAction::Model {
                    req: ModelRequest::Get,
                    reply_tx,
                } => {
                    let _ = reply_tx.send(Ok(json!({ "spec": MODEL_SPEC })));
                }
                other => {
                    let _ = forward_tx.send(other);
                }
            }
        }
    });
    forward_rx
}

fn exec_tool(
    registry: &ToolRegistry,
    name: &str,
    input: serde_json::Value,
) -> Result<String, String> {
    let entry = registry
        .get(name)
        .unwrap_or_else(|| panic!("tool {name} not registered"));
    let invocation = entry.tool.parse(&input).expect("parse failed");
    let context = maki_agent::tools::test_support::stub_ctx(&maki_agent::AgentMode::Build);
    smol::block_on(async { invocation.execute(&context).await })
        .output
        .map_or_else(Err, |output| match output {
            maki_agent::ToolOutput::Plain(text) => Ok(text.text),
            other => panic!("unexpected output: {other:?}"),
        })
}

fn owner_ids(state: &Path) -> Vec<String> {
    let mut ids = fs::read_dir(state.join("peers/owners"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .map(|path| path.file_stem().unwrap().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

fn wait_for_model(state: &Path, id: &str) {
    let path = state.join("peers/owners").join(format!("{id}.json"));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(text) = fs::read_to_string(&path)
            && text.contains(MODEL_SPEC)
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "owner record never gained the model"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_mailbox(mailbox: &SessionMailbox) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let messages = mailbox.drain();
        if let Some(message) = messages.first() {
            return message
                .user_text()
                .expect("peer message should be an observation")
                .to_owned();
        }
        assert!(Instant::now() < deadline, "peer message did not arrive");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Each test gets its own process under nextest, which is what lets several
/// tests in this binary redirect the process-wide XDG environment.
/// Writes a spool record by hand, so the receiving side is exercised against a
/// file it did not produce itself.
fn write_inbound(state: &Path, id: &str, message: serde_json::Value) -> PathBuf {
    let inbox = state.join("peers/inboxes").join(id);
    fs::create_dir_all(&inbox).unwrap();
    let path = inbox.join(format!("{}.json", message["id"].as_str().unwrap()));
    fs::write(&path, serde_json::to_vec(&message).unwrap()).unwrap();
    path
}

fn inbound(to: &str, body: &str, session: Option<&str>, origin: Option<&str>) -> serde_json::Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let mut message = json!({
        "protocol": 1,
        "id": format!("remote-{body}"),
        "from": "peer-remote",
        "from_name": "remote-host",
        "to": to,
        "kind": "observation",
        "body": body,
        "created": now,
        "expires": now + 300,
    });
    if let Some(session) = session {
        message["session"] = json!(session);
    }
    if let Some(host) = origin {
        message["origin"] = json!({ "host": host });
    }
    message
}

#[test]
fn peer_command_opens_a_list_window() {
    let (_temp, _state) = common::isolated_state();

    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let forward = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    host.event_handle()
        .run_command(Arc::from(PLUGIN_NAME), Arc::from("/peer"), String::new(), 0);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let action = forward
            .recv_timeout(Duration::from_secs(5))
            .expect("the /peer command should open a list window");
        let UiAction::OpenWin { buf, .. } = action else {
            assert!(
                Instant::now() < deadline,
                "the /peer command never opened a window"
            );
            continue;
        };
        let text = buf
            .read()
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.text.as_str())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            text.contains("via maki") && text.contains("(local)"),
            "the window should hold the shared list lines, got: {text}"
        );
        assert!(
            !text.contains("Local peer:"),
            "the header line is gone, got: {text}"
        );
        break;
    }

    drop(host);
}

/// Build a presence record the way another host would write it.
fn owner_record(
    id: &str,
    name: &str,
    age_secs: i64,
    cwd: Option<&str>,
    model: Option<&str>,
) -> serde_json::Value {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let mut record = json!({
        "protocol": 1,
        "id": id,
        "name": name,
        "started": now - 3600,
        "last_seen": now - age_secs,
        "status": "idle",
    });
    if let Some(cwd) = cwd {
        record["cwd"] = json!(cwd);
    }
    if let Some(model) = model {
        record["model"] = json!(model);
    }
    record
}

fn write_owner(state: &Path, record: &serde_json::Value) {
    let dir = state.join("peers/owners");
    fs::create_dir_all(&dir).unwrap();
    let id = record["id"].as_str().unwrap();
    fs::write(
        dir.join(format!("{id}.json")),
        serde_json::to_vec(record).unwrap(),
    )
    .unwrap();
}

fn queued_count(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|entries| entries.count())
        .unwrap_or(0)
}

fn cwd() -> String {
    std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .trim_end_matches('/')
        .to_owned()
}

#[test]
fn a_name_suffix_resolves_to_a_peer() {
    let (_temp, state) = common::isolated_state();
    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    write_owner(
        &state,
        &owner_record("oc-abc123def4567890", "opencode-072f28", 1, None, None),
    );
    let out = exec_tool(
        &registry,
        "peer_send",
        json!({ "peer_id": "072f28", "message": "suffix works" }),
    )
    .unwrap();
    assert!(out.contains("Queued peer message"), "got: {out}");
    assert!(out.contains("oc-abc123def4567890"), "got: {out}");
    drop(host);
}

#[test]
fn an_id_prefix_resolves_to_a_peer() {
    let (_temp, state) = common::isolated_state();
    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    write_owner(
        &state,
        &owner_record("oc-abc123def4567890", "opencode-072f28", 1, None, None),
    );
    let out = exec_tool(
        &registry,
        "peer_send",
        json!({ "peer_id": "oc-abc123", "message": "prefix works" }),
    )
    .unwrap();
    assert!(out.contains("Queued peer message"), "got: {out}");
    drop(host);
}

#[test]
fn an_unmatched_target_lists_the_candidates() {
    let (_temp, state) = common::isolated_state();
    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    write_owner(
        &state,
        &owner_record("oc-abc123def4567890", "opencode-072f28", 1, None, None),
    );
    let err = exec_tool(
        &registry,
        "peer_send",
        json!({ "peer_id": "nosuch", "message": "hello" }),
    )
    .unwrap_err();
    assert!(
        err.contains(
            "no live peer matches \"nosuch\"; pass one of: opencode-072f28 [oc-abc123def4567890]"
        ),
        "got: {err}"
    );
    drop(host);
}

#[test]
fn an_ambiguous_target_reports_every_match() {
    let (_temp, state) = common::isolated_state();
    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    write_owner(
        &state,
        &owner_record("oc-1111111111111111", "opencode:aaaaaa", 1, None, None),
    );
    write_owner(
        &state,
        &owner_record("oc-1111111111111112", "opencode:bbbbbb", 1, None, None),
    );
    let err = exec_tool(
        &registry,
        "peer_send",
        json!({ "peer_id": "oc-1111", "message": "hello" }),
    )
    .unwrap_err();
    assert!(
        err.contains("\"oc-1111\" matches 2 peers: opencode:aaaaaa [oc-1111111111111111], opencode:bbbbbb [oc-1111111111111112]"),
        "got: {err}"
    );
    drop(host);
}

#[test]
fn a_stale_match_says_the_peer_may_have_exited() {
    let (_temp, state) = common::isolated_state();
    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    write_owner(
        &state,
        &owner_record("oc-abc123def4567890", "opencode-072f28", 90, None, None),
    );
    let err = exec_tool(
        &registry,
        "peer_send",
        json!({ "peer_id": "072f28", "message": "hello" }),
    )
    .unwrap_err();
    assert!(
        err.contains("peer opencode-072f28 [oc-abc123def4567890] last refreshed")
            && err.contains("it may have exited"),
        "got: {err}"
    );
    drop(host);
}

#[test]
fn the_presence_record_carries_the_working_directory() {
    let (_temp, state) = common::isolated_state();
    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    let id = owner_ids(&state)
        .into_iter()
        .next()
        .expect("peer should register");
    let record: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(state.join("peers/owners").join(format!("{id}.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(record["protocol"], 1, "the protocol version must not move");
    assert_eq!(
        record["cwd"],
        json!(cwd()),
        "the record should name the project directory"
    );
    drop(host);
}

#[test]
fn the_list_marks_local_and_same_dir() {
    let (_temp, state) = common::isolated_state();
    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();
    let id = owner_ids(&state)
        .into_iter()
        .next()
        .expect("peer should register");

    write_owner(
        &state,
        &owner_record(
            "oc-abc123def4567890",
            "opencode-072f28",
            1,
            Some(&format!("{}/", cwd())),
            Some("zai/glm-5"),
        ),
    );
    let out = exec_tool(&registry, "peer_list", json!({})).unwrap();
    let line = out
        .lines()
        .find(|line| line.contains("oc-abc123def4567890"))
        .unwrap_or_else(|| panic!("got: {out}"));
    assert_eq!(
        line,
        "- oc-abc123def4567890  idle  zai/glm-5  opencode-072f28  -  via maki  (local)  (same dir)",
        "got: {line}"
    );
    let own = out
        .lines()
        .find(|line| line.contains(&id))
        .unwrap_or_else(|| panic!("got: {out}"));
    assert!(
        own.contains("(local)"),
        "the local peer should be marked, got: {own}"
    );
    assert!(own.contains("  via maki  "), "got: {own}");
    drop(host);
}

#[test]
fn a_peer_without_a_cwd_is_simply_not_same_dir() {
    let (_temp, state) = common::isolated_state();
    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    write_owner(
        &state,
        &owner_record("oc-abc123def4567890", "opencode-072f28", 1, None, None),
    );
    let out = exec_tool(&registry, "peer_list", json!({})).unwrap();
    let other = out
        .lines()
        .find(|line| line.contains("oc-abc123def4567890"))
        .unwrap_or_else(|| panic!("got: {out}"));
    assert!(
        !other.contains("(same dir)"),
        "an absent cwd must not be guessed, got: {other}"
    );
    drop(host);
}

#[test]
fn same_dir_only_broadcast_skips_peers_in_other_directories() {
    let (_temp, state) = common::isolated_state();
    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    write_owner(
        &state,
        &owner_record(
            "oc-samerepo11111111",
            "opencode:aaaaaa",
            1,
            Some(&cwd()),
            None,
        ),
    );
    write_owner(
        &state,
        &owner_record(
            "oc-elsewhere2222222",
            "opencode:bbbbbb",
            1,
            Some("/somewhere/else"),
            None,
        ),
    );

    let out = exec_tool(
        &registry,
        "peer_broadcast",
        json!({ "message": "same dir only", "same_dir_only": true }),
    )
    .unwrap();
    assert_eq!(out, "Queued 1 peer messages.", "got: {out}");

    let same = state.join("peers/inboxes").join("oc-samerepo11111111");
    let other = state.join("peers/inboxes").join("oc-elsewhere2222222");
    assert_eq!(
        queued_count(&same),
        1,
        "the same repo peer should be queued"
    );
    assert_eq!(
        queued_count(&other),
        0,
        "the other repo peer should be skipped"
    );
    drop(host);
}

#[test]
fn two_plugin_hosts_exchange_an_observation() {
    let (_temp, state) = common::isolated_state();

    let (first_registry, first_host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _first_forward = serve_ui_actions(first_host.ui_action_rx());
    let first_output = exec_tool(&first_registry, "peer_list", json!({})).unwrap();
    assert!(first_output.contains(" via maki "), "got: {first_output}");
    assert!(first_output.contains("(local)"), "got: {first_output}");
    let first_id = owner_ids(&state)
        .into_iter()
        .next()
        .expect("first peer should register");
    wait_for_model(&state, &first_id);
    let first_output = exec_tool(&first_registry, "peer_list", json!({})).unwrap();
    assert!(
        first_output.contains(MODEL_SPEC),
        "peer list should show the running model, got: {first_output}"
    );

    let (second_registry, second_host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let second_forward = serve_ui_actions(second_host.ui_action_rx());
    exec_tool(&second_registry, "peer_list", json!({})).unwrap();
    let second_id = owner_ids(&state)
        .into_iter()
        .find(|id| id != &first_id)
        .expect("second peer should register");

    second_host.event_handle().run_command(
        Arc::from(PLUGIN_NAME),
        Arc::from("/peer"),
        "send not/a/peer hello".to_owned(),
        0,
    );
    let UiAction::Flash(message) = second_forward
        .recv_timeout(Duration::from_secs(5))
        .expect("peer command should answer through the UI")
    else {
        panic!("peer command should flash an error");
    };
    assert!(
        message.contains("Could not send peer message"),
        "got: {message}"
    );

    let session_id = MakiId::generate();
    let mailbox = SessionMailbox::register(session_id);
    let receipt = exec_tool(
        &first_registry,
        "peer_send",
        json!({
            "peer_id": second_id,
            "message": "hello from the first peer",
            "session": session_id.to_string(),
        }),
    )
    .unwrap();
    assert!(receipt.contains("Queued peer message"), "got: {receipt}");

    let delivered = wait_for_mailbox(&mailbox);
    assert!(
        delivered.contains("hello from the first peer"),
        "got: {delivered}"
    );
    let inbox = state.join("peers/inboxes").join(second_id);
    assert!(owner_ids(&state).contains(&first_id));
    assert!(
        fs::read_dir(inbox).unwrap().next().is_none(),
        "delivered message should be removed"
    );

    drop(first_host);
    drop(second_host);
}

#[test]
fn queued_messages_name_the_sending_host() {
    let (_temp, state) = common::isolated_state();

    let (first_registry, first_host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(first_host.ui_action_rx());
    let first_id = {
        exec_tool(&first_registry, "peer_list", json!({})).unwrap();
        owner_ids(&state)
            .into_iter()
            .next()
            .expect("first peer should register")
    };

    let (second_registry, second_host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(second_host.ui_action_rx());
    exec_tool(&second_registry, "peer_list", json!({})).unwrap();
    let second_id = owner_ids(&state)
        .into_iter()
        .find(|id| id != &first_id)
        .expect("second peer should register");

    let session_id = MakiId::generate();
    let _mailbox = SessionMailbox::register(session_id);
    exec_tool(
        &first_registry,
        "peer_send",
        json!({
            "peer_id": second_id,
            "message": "tagged",
            "session": session_id.to_string(),
        }),
    )
    .unwrap();

    let queued_dir = state.join("peers/inboxes").join(second_id);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let queued = fs::read_dir(&queued_dir)
            .map(|mut entries| entries.next().map(|entry| entry.unwrap().path()))
            .unwrap_or(None);
        if let Some(path) = queued
            && let Ok(text) = fs::read_to_string(&path)
            && let Ok(record) = serde_json::from_str::<serde_json::Value>(&text)
        {
            assert_eq!(
                record["origin"]["host"], "maki",
                "queued message should name its host, got: {record}"
            );
            break;
        }
        assert!(Instant::now() < deadline, "no queued message appeared");
        std::thread::sleep(Duration::from_millis(20));
    }

    drop(first_host);
    drop(second_host);
}

#[test]
fn a_foreign_host_session_id_is_ignored_and_the_local_session_is_used() {
    let (_temp, state) = common::isolated_state();

    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();
    let id = owner_ids(&state)
        .into_iter()
        .next()
        .expect("peer should register");

    let live = MakiId::generate();
    let mailbox = SessionMailbox::register(live);
    host.event_handle().fire_autocmd(
        "SessionStatusChanged",
        json!({ "session_id": live.to_string(), "status": "idle" }),
    );

    write_inbound(
        &state,
        &id,
        inbound(
            &id,
            "from-opencode",
            Some("ses_not_a_maki_id"),
            Some("opencode"),
        ),
    );

    let delivered = wait_for_mailbox(&mailbox);
    assert!(
        delivered.contains("from-opencode"),
        "a foreign session id must not divert the message, got: {delivered}"
    );

    drop(host);
}

#[test]
fn a_message_for_a_dead_session_is_dropped_instead_of_retried() {
    let (_temp, state) = common::isolated_state();

    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();
    let id = owner_ids(&state)
        .into_iter()
        .next()
        .expect("peer should register");

    let live = MakiId::generate();
    let mailbox = SessionMailbox::register(live);
    host.event_handle().fire_autocmd(
        "SessionStatusChanged",
        json!({ "session_id": live.to_string(), "status": "idle" }),
    );

    let dead = MakiId::generate();
    let path = write_inbound(
        &state,
        &id,
        inbound(&id, "for-a-dead-tab", Some(&dead.to_string()), Some("maki")),
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    while path.exists() {
        assert!(
            Instant::now() < deadline,
            "a message for a dead session should be dropped, not retried until it expires"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        mailbox.drain().is_empty(),
        "a dead-session message must not land in the focused session"
    );

    drop(host);
}

#[test]
fn peer_list_reports_the_focused_session_status() {
    let (_temp, _state) = common::isolated_state();

    let (registry, host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _ = serve_ui_actions(host.ui_action_rx());
    exec_tool(&registry, "peer_list", json!({})).unwrap();

    let live = MakiId::generate();
    let _mailbox = SessionMailbox::register(live);
    host.event_handle().fire_autocmd(
        "SessionStatusChanged",
        json!({ "session_id": live.to_string(), "status": "needs_input" }),
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let output = exec_tool(&registry, "peer_list", json!({})).unwrap();
        if output.contains("needs_input") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "a status change should reach the presence record, last saw: {output}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }

    drop(host);
}
