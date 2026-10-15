use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use maki_agent::SessionMailbox;
use maki_agent::tools::ToolRegistry;
use maki_lua::{ModelRequest, PluginHost, PluginPermissions, UiAction};
use maki_storage::id::MakiId;
use serde_json::json;
use tempfile::TempDir;

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
fn isolated_state() -> (TempDir, PathBuf) {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    unsafe {
        std::env::set_var("HOME", root);
        std::env::set_var("XDG_STATE_HOME", root);
        std::env::set_var("XDG_DATA_HOME", root);
        std::env::set_var("XDG_CONFIG_HOME", root);
        std::env::set_var("XDG_CACHE_HOME", root);
    }
    let state = maki_storage::paths::state_dir().unwrap();
    (temp, state)
}

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
fn two_plugin_hosts_exchange_an_observation() {
    let (_temp, state) = isolated_state();

    let (first_registry, first_host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let _first_forward = serve_ui_actions(first_host.ui_action_rx());
    let first_output = exec_tool(&first_registry, "peer_list", json!({})).unwrap();
    assert!(first_output.contains("Local peer:"), "got: {first_output}");
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
    let (_temp, state) = isolated_state();

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
    let (_temp, state) = isolated_state();

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
    let (_temp, state) = isolated_state();

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
    let (_temp, _state) = isolated_state();

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
