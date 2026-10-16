//! Shared setup for both test binaries.
//!
//! The plugin registers a presence record from its poll loop, which the host
//! runtime runs as soon as a test gives it a turn. A test that loads the host
//! without redirecting the XDG environment therefore writes into the real
//! spool. Every test that loads the host must call `isolated_state` first.
//!
//! Redirecting the environment is process-wide, so this only works because
//! `cargo nextest` gives every test its own process. The `justfile` and CI both
//! use nextest; plain `cargo test` would race these tests against each other.

use std::path::PathBuf;

use tempfile::TempDir;

pub fn isolated_state() -> (TempDir, PathBuf) {
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
