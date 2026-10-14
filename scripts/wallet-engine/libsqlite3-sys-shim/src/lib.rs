//! libsqlite3-sys 0.35 API, backed by sqlite-wasm-rs on wasm32-unknown-unknown.
#![allow(non_upper_case_globals, non_camel_case_types, non_snake_case)]

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
pub use sqlite_wasm_rs::*;

#[cfg(not(all(target_family = "wasm", target_os = "unknown")))]
pub use native::*;
