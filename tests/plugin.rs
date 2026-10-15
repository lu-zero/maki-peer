use std::path::Path;
use std::sync::Arc;

use maki_agent::ToolOutput;
use maki_agent::tools::ToolRegistry;
use maki_lua::{PluginHost, PluginPermissions};
use serde_json::json;

const PLUGIN_NAME: &str = "maki-peer";

fn plugin_host() -> (Arc<ToolRegistry>, PluginHost) {
    let reg = Arc::new(ToolRegistry::new());
    let host = PluginHost::new(Arc::clone(&reg)).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    host.load_package(
        PLUGIN_NAME,
        root,
        PluginPermissions::trusted(),
        Default::default(),
    )
    .unwrap();
    (reg, host)
}

fn exec_tool(reg: &ToolRegistry, name: &str, input: serde_json::Value) -> Result<String, String> {
    let entry = reg
        .get(name)
        .unwrap_or_else(|| panic!("tool {name} not registered"));
    let inv = entry.tool.parse(&input).expect("parse failed");
    let ctx = maki_agent::tools::test_support::stub_ctx(&maki_agent::AgentMode::Build);
    smol::block_on(async { inv.execute(&ctx).await })
        .output
        .map_or_else(Err, |out| match out {
            ToolOutput::Plain(s) => Ok(s.text),
            other => panic!("unexpected output: {other:?}"),
        })
}

#[test]
fn tools_register() {
    let (reg, _host) = plugin_host();
    for name in ["peer_list", "peer_send", "peer_broadcast", "peer_spawn"] {
        assert!(reg.has(name), "peer tool {name} should register");
    }
}

#[test]
fn peer_send_rejects_invalid_ids() {
    let (reg, _host) = plugin_host();
    let err = exec_tool(
        &reg,
        "peer_send",
        json!({ "peer_id": "not/a/path", "message": "hello" }),
    )
    .unwrap_err();
    assert!(err.contains("invalid peer id"), "got: {err}");
}

#[test]
fn peer_spawn_rejects_unknown_launchers() {
    let (reg, _host) = plugin_host();
    let err = exec_tool(
        &reg,
        "peer_spawn",
        json!({ "launcher": "native", "prompt": "hello" }),
    )
    .unwrap_err();
    assert!(err.contains("only the tmux launcher"), "got: {err}");
}

#[test]
fn peer_spawn_rejects_malformed_model_specs() {
    let (reg, _host) = plugin_host();
    let err = exec_tool(
        &reg,
        "peer_spawn",
        json!({ "prompt": "hello", "model": "not-a-spec" }),
    )
    .unwrap_err();
    assert!(err.contains("provider/model-id"), "got: {err}");
}

#[test]
fn peer_spawn_rejects_unresolvable_models() {
    let (reg, _host) = plugin_host();
    let err = exec_tool(
        &reg,
        "peer_spawn",
        json!({ "prompt": "hello", "model": "definitely-not-a-provider-xyz/glm" }),
    )
    .unwrap_err();
    assert!(err.contains("did not resolve"), "got: {err}");
}

#[test]
fn peer_spawn_valid_model_passes_validation() {
    let (reg, _host) = plugin_host();
    let err = exec_tool(
        &reg,
        "peer_spawn",
        json!({ "prompt": "hello", "model": "anthropic/claude-opus-4-6", "launcher": "native" }),
    )
    .unwrap_err();
    assert!(err.contains("only the tmux launcher"), "got: {err}");
}
