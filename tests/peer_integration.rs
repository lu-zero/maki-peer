use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use maki_agent::SessionMailbox;
use maki_agent::tools::ToolRegistry;
use maki_lua::{PluginHost, PluginPermissions, UiAction};
use maki_storage::id::MakiId;
use serde_json::json;
use tempfile::TempDir;

const PLUGIN_NAME: &str = "maki-peer";

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

#[test]
fn two_plugin_hosts_exchange_an_observation() {
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

    let (first_registry, first_host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    let first_output = exec_tool(&first_registry, "peer_list", json!({})).unwrap();
    assert!(first_output.contains("Local peer:"), "got: {first_output}");
    let first_id = owner_ids(&state)
        .into_iter()
        .next()
        .expect("first peer should register");

    let (second_registry, second_host) = plugin_host(Path::new(env!("CARGO_MANIFEST_DIR")));
    exec_tool(&second_registry, "peer_list", json!({})).unwrap();
    let second_id = owner_ids(&state)
        .into_iter()
        .find(|id| id != &first_id)
        .expect("second peer should register");

    let actions = second_host.ui_action_rx();
    second_host.event_handle().run_command(
        Arc::from(PLUGIN_NAME),
        Arc::from("/peer"),
        "send not/a/peer hello".to_owned(),
        0,
    );
    let UiAction::Flash(message) = actions
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
