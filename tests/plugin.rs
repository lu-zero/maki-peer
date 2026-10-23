use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use maki_agent::ToolOutput;
use maki_agent::tools::ToolRegistry;
use maki_lua::{PluginHost, PluginPermissions};
use maki_storage::id::{MakiId, SessionRef};
use serde_json::json;

mod common;

const PLUGIN_NAME: &str = "maki-peer";

/// The `TempDir` is returned so the caller holds it. Binding it inside this
/// function dropped it on return, which deleted the spool the host was still
/// using: the plugin recreated the directory often enough that tests passed,
/// and not often enough that `peer_send` sometimes read an owners directory
/// that was gone and reported that instead of a list of live peers.
fn plugin_host() -> (tempfile::TempDir, Arc<ToolRegistry>, PluginHost) {
    // The poll loop the plugin schedules from a zero delay timer registers a
    // presence record the first time the runtime yields, so a test that loads
    // the host without redirecting XDG writes into the real spool.
    let (temp, _state) = common::isolated_state();
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
    (temp, reg, host)
}

fn exec_tool(reg: &ToolRegistry, name: &str, input: serde_json::Value) -> Result<String, String> {
    let entry = reg
        .get(name)
        .unwrap_or_else(|| panic!("tool {name} not registered"));
    let inv = entry.tool.parse(&input).expect("parse failed");
    let mut ctx = maki_agent::tools::test_support::stub_ctx(&maki_agent::AgentMode::Build);
    ctx.session_id = Some(SessionRef::from_id(MakiId::generate()));
    smol::block_on(async { inv.execute(&ctx).await })
        .output
        .map_or_else(Err, |out| match out {
            ToolOutput::Plain(s) => Ok(s.text),
            other => panic!("unexpected output: {other:?}"),
        })
}

#[test]
fn tools_register() {
    let (_temp, reg, _host) = plugin_host();
    for name in ["peer_list", "peer_send", "peer_broadcast", "peer_spawn"] {
        assert!(reg.has(name), "peer tool {name} should register");
    }
}

#[test]
fn peer_send_reports_an_unmatched_target() {
    let (_temp, reg, _host) = plugin_host();
    let err = exec_tool(
        &reg,
        "peer_send",
        json!({ "peer_id": "not/a/path", "message": "hello" }),
    )
    .unwrap_err();
    assert!(
        err.contains("no live peer matches \"not/a/path\""),
        "got: {err}"
    );
}

#[test]
fn peer_spawn_rejects_unknown_launchers() {
    let (_temp, reg, _host) = plugin_host();
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
    let (_temp, reg, _host) = plugin_host();
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
    let (_temp, reg, _host) = plugin_host();
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
    let (_temp, reg, _host) = plugin_host();
    let err = exec_tool(
        &reg,
        "peer_spawn",
        json!({ "prompt": "hello", "model": "anthropic/claude-opus-4-6", "launcher": "native" }),
    )
    .unwrap_err();
    assert!(err.contains("only the tmux launcher"), "got: {err}");
}

/// The halves are meant to read the same, so the tool descriptions are
/// identical. They drifted once, in two ways at once, and nothing noticed: a
/// test is cheaper than a convention.
#[test]
fn the_halves_declare_the_same_tool_descriptions() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let lua =
        std::fs::read_to_string(root.join("plugin/maki_peer.lua")).expect("maki plugin source");
    let ts = std::fs::read_to_string(root.join("opencode/src/index.ts"))
        .expect("opencode plugin source");
    let grok = std::fs::read_to_string(root.join("grok/src/mcp.ts")).expect("grok plugin source");

    for (tool, prefix) in [
        (
            "peer_send",
            "Send an observation or status to one named peer",
        ),
        ("peer_broadcast", "Send an observation to EVERY peer"),
    ] {
        let on_maki = description(&lua, "description = \"", prefix);
        let on_opencode = description(&ts, "description: \"", prefix);
        let on_grok = description(&grok, "description: \"", prefix);
        assert_eq!(
            on_maki, on_opencode,
            "the {tool} description differs between maki and opencode"
        );
        assert_eq!(
            on_maki, on_grok,
            "the {tool} description differs between maki and grok"
        );
    }
}

/// The quoted string that follows the first description marker whose text
/// starts with `prefix`.
fn description(source: &str, marker: &str, prefix: &str) -> String {
    let mut rest = source;
    while let Some(at) = rest.find(marker) {
        rest = &rest[at + marker.len()..];
        let end = rest.find('"').expect("a description with no closing quote");
        let text = &rest[..end];
        if text.starts_with(prefix) {
            return text.to_owned();
        }
        rest = &rest[end..];
    }
    panic!("no description starting with {prefix:?}");
}

/// The plugin is one Lua chunk loaded in file order, so a call to a
/// `local function` sitting above its own declaration resolves to a global,
/// which is nil, and throws on every call. Nothing else here can catch that: it
/// needs a live UI, and it fails silently, because `maki.async.run` without
/// `on_finish` swallows closure errors. A single forward reference shipped three
/// confident wrong diagnoses before anyone read the file top to bottom, so the
/// ordering is asserted here instead.
///
/// Line based and deliberately narrow. It sees `local function NAME`
/// declarations with `--` comments cut at the first `--`, which is wrong for the
/// two argv strings that contain one and harmless there. It cannot see a
/// shadowing declaration inside a nested block, and it says nothing about a
/// `local NAME = function` form the plugin does not use. Strings are not
/// stripped, so a function name inside one would be reported.
#[test]
fn no_call_sits_above_the_local_function_it_calls() {
    let src =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("plugin/maki_peer.lua"))
            .expect("plugin source");

    let mut declared: BTreeMap<&str, usize> = BTreeMap::new();
    let mut offenders: Vec<String> = Vec::new();

    // Declarations first, in their own pass. Collecting them while walking call
    // sites inverts the test: a forward reference is precisely a call whose
    // declaration has not been reached yet, so it would never be found.
    for (i, raw) in src.lines().enumerate() {
        let code = match raw.find("--") {
            Some(at) => &raw[..at],
            None => raw,
        };
        if let Some(rest) = code.trim_start().strip_prefix("local function ") {
            let name = rest.split(['(', ' ']).next().unwrap_or("").trim();
            if !name.is_empty() {
                declared.entry(name).or_insert(i + 1);
            }
        }
    }

    for (i, raw) in src.lines().enumerate() {
        let line_no = i + 1;
        let code = match raw.find("--") {
            Some(at) => &raw[..at],
            None => raw,
        };

        let bytes = code.as_bytes();
        let mut at = 0;
        while at < bytes.len() {
            if !(bytes[at].is_ascii_alphabetic() || bytes[at] == b'_') {
                at += 1;
                continue;
            }
            let start = at;
            while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_') {
                at += 1;
            }
            let member = start > 0 && matches!(bytes[start - 1], b'.' | b':');
            if member {
                continue;
            }
            // An identifier that is the target of an assignment is a key or a
            // variable, not a use: `current_session = nil` in the runtime table
            // says nothing about the function declared later. `==` is a
            // comparison and still counts as a use.
            let mut after = at;
            while after < bytes.len() && bytes[after] == b' ' {
                after += 1;
            }
            let assigns =
                after < bytes.len() && bytes[after] == b'=' && bytes.get(after + 1) != Some(&b'=');
            if assigns {
                continue;
            }
            // Any bare reference counts, not only a call. A function handed to
            // pcall, or used from inside a closure defined earlier, is just as
            // out of scope, and a guard that only looked for `name(` passed on
            // exactly that.
            if let Some(&decl_at) = declared.get(&code[start..at])
                && line_no < decl_at
            {
                offenders.push(format!(
                    "line {line_no} refers to {} declared at line {decl_at}",
                    &code[start..at]
                ));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "a call above its own declaration resolves to nil at runtime:\n  {}",
        offenders.join("\n  ")
    );
}
