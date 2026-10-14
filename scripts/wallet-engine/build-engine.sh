#!/usr/bin/env bash
# Zocial World — reproducible build v2 of the Stage-2 ("Ironwood") in-game wallet engine
# (ADR-018 § 3, § 7) and of the server's decryption helper (ADR-018 § 5/§ 6).
#
#   build-engine.sh [main|regtest|helper|all] [WORK_DIR]
#
#   main     -> $OUT/webzjs-wallet-main/      the shippable mainnet package
#   regtest  -> $OUT/webzjs-wallet-regtest/   TESTING ONLY (network "test" = local regtest chain,
#                                             every upgrade through NU6.3 at height 1)
#   helper   -> $OUT/zw-tx-decrypt/           Node.js package for the game server
#   all      -> all three (default)
#
# Sources: WebZjs @ WEBZJS_REV + patches/webzjs/*.diff in file-name order:
#   0001-0003  Stage 1 (the Sapling beta engine)
#   0004-0005  Stage 2 (0004: the receive side on zcash_client_sqlite; 0005: the full Stage 2 engine)
# + libsqlite3-sys-shim/ (the libsqlite3-sys 0.35 API on sqlite-wasm-rs; installed at
#   WebZjs/zw/libsqlite3-sys-shim, where Cargo.toml's [patch.crates-io] points; must equal what 0004 adds)
# + SQLite compiled FROM SOURCE by build-sqlite.sh (emscripten 4.0.12, pinned), linked instead of the
#   prebuilt library inside sqlite-wasm-rs 0.4.3 (SQLITE_WASM_RS_PREBUILD_LD_LIB_PATH).
# librustzcash and orchard are pinned by WebZjs's Cargo.toml [patch.crates-io] + Cargo.lock; the helper
# reuses exactly that Cargo.lock (no version may differ, checked).
#
# Environment: CARGO_BUILD_JOBS (default 2), NICE (19), OUT ($WORK/out), DL_CACHE (directory of
# already downloaded tarballs; every file is still checked against its pin), BINARYEN_DIR,
# WASM_BINDGEN_DIR, WASM_PACK_DIR, JUST_DIR (existing installs of the pinned tools; else built or
# downloaded and checked), EXPECT_MAIN_WASM_SHA256 / EXPECT_REGTEST_WASM_SHA256 /
# EXPECT_HELPER_WASM_SHA256 / EXPECT_SQLITE_LIB_SHA256 (fail when an output differs),
# ALLOW_TOOL_MISMATCH=1 (continue, with a warning, with a tool other than the pinned one).
#
# Supply chain: every tool or input that touches the
# shipped bytes is pinned by CONTENT:
#   Rust nightly-2025-06-15   the channel manifest's SHA-256 is pinned (rustup checks every component
#                             against that manifest) and the installed rustc must be its commit;
#   Rust 1.97.0               same, for compiling the build tools below
#   wasm-bindgen-cli 0.2.100  `cargo install --locked` from checksummed crates.io sources
#   wasm-pack 0.15.0          same (wasm-pack's own installer would download an unverified binary)
#   just 1.58.0               same (runs WebZjs's build-wallet recipe)
#   binaryen version_117      release tarball SHA-256
#   emscripten 4.0.12         release tarball SHA-256; its libc rebuilt from source (build-sqlite.sh)
#   SQLite 3.50.4             official amalgamation SHA-256; sqlite-wasm-rs crate checksum (= Cargo.lock)
#   crates / git deps         Cargo.lock checksums and revisions; Cargo.lock must not change in the build
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WHAT=${1:-all}
WORK=$(mkdir -p "${2:-$HERE/work}" && cd "${2:-$HERE/work}" && pwd)
OUT=${OUT:-$WORK/out}
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
NICE=${NICE:-19}
DL=${DL_CACHE:-$WORK/dl}
export DL_CACHE=$DL
mkdir -p "$DL" "$WORK/tools"

# ---- PINS (bump these for NU7; see README.md) --------------------------------------------------
WEBZJS_REPO=https://github.com/ZcashCommunityGrants/WebZjs
WEBZJS_REV=bdbc6f2f9e8c60f722c73ca7c83b48b861428f70          # red.dev NU6.3 port (main, 2026-09-11)
LIBRUSTZCASH_REV=0a2c6d1ae6274e6af2291e312f7b7459516882f2    # (pinned inside WebZjs Cargo.toml after the patches)
ORCHARD_REV=3bd2b736d1273226595773265313fc3f3428af16         # (same)
SQLITE_WASM_RS_CRATE_SHA256=0894a1b91dc660fbf1e6ea6f287562708e01ca1a18fa4e2c6dae0df5a05199c5  # sqlite-wasm-rs 0.4.3
TOOLCHAIN=nightly-2025-06-15                                  # WebZjs rust-toolchain.toml
RUST_CHANNEL_MANIFEST_SHA256=84c95b367d3101a2caf840f07715bff19942f3f1872e9161a81d9f842a23fe25  # dist/2025-06-15/channel-rust-nightly.toml
RUSTC_COMMIT=49a8ba06848fa8f282fe9055b4178350970bb0ce          # rustc 1.89.0-nightly (49a8ba068 2025-06-14)
# The build tools below are compiled with a pinned STABLE release (wasm-pack 0.15.0's own Cargo.lock
# needs rustc >= 1.91; the engine itself keeps the nightly above).
TOOLS_TOOLCHAIN=1.97.0
TOOLS_CHANNEL_MANIFEST_SHA256=3804d2666f7c12ce64205baa69b6be52f910b45b158091013264beb7aa1de7f5  # dist/channel-rust-1.97.0.toml
TOOLS_RUSTC_COMMIT=2d8144b7880597b6e6d3dfd63a9a9efae3f533d3    # rustc 1.97.0 (2d8144b78 2026-07-07)
WASM_PACK_VERSION=0.15.0
WASM_BINDGEN_VERSION=0.2.100                                  # = the wasm-bindgen crate in Cargo.lock
JUST_VERSION=1.58.0
BINARYEN_VERSION=version_117
BINARYEN_SHA256=3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212  # binaryen-version_117-x86_64-linux.tar.gz
# Published outputs of this exact source set (the Stage 2 engine, patches 0001-0005; built twice in two
# directories, byte-identical):
PUBLISHED_MAIN_WASM_SHA256=772d260643a874e261e5067324243b255194b90d2c91d0513e4b6ac0a25e3854
PUBLISHED_REGTEST_WASM_SHA256=768907a2c2317225aea50c6707dc612a5046920b679b72750968ed3112a4bf1b
# ------------------------------------------------------------------------------------------------

log() { echo "[build-engine] $*"; }
die() { echo "[build-engine] $*" >&2; exit "${2:-3}"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
need() { command -v "$1" >/dev/null || die "missing tool: $1 ($2)" 2; }
tool_mismatch() { # message
  if [ "${ALLOW_TOOL_MISMATCH:-}" = 1 ]; then
    log "WARNING: $1 (ALLOW_TOOL_MISMATCH=1: the output will not match the pinned build)"
  else
    die "$1 - install the pinned version, or set ALLOW_TOOL_MISMATCH=1 for an unpinned test build" 2
  fi
}
need git git; need cargo "rustup + cargo"; need rustup "https://rustup.rs"; need sha256sum coreutils
need python3 python3; need curl curl; need node "Node.js (helper tests, emscripten)"; need xz xz-utils

# ---- Rust toolchain: the channel manifest by hash, rustc by commit ------------------------------
rustup toolchain list | grep -q "^$TOOLCHAIN" || rustup toolchain install "$TOOLCHAIN" --profile minimal --component rust-src --target wasm32-unknown-unknown
MANIFEST="$DL/channel-rust-${TOOLCHAIN#nightly-}-nightly.toml"
if [ ! -f "$MANIFEST" ] || [ "$(sha "$MANIFEST")" != "$RUST_CHANNEL_MANIFEST_SHA256" ]; then
  curl -fsSL -o "$MANIFEST" "https://static.rust-lang.org/dist/${TOOLCHAIN#nightly-}/channel-rust-nightly.toml"
fi
[ "$(sha "$MANIFEST")" = "$RUST_CHANNEL_MANIFEST_SHA256" ] || die "the Rust $TOOLCHAIN channel manifest does not match its pinned SHA-256"
grep -A2 '^\[pkg.rustc\]' "$MANIFEST" | grep -q "git_commit_hash = \"$RUSTC_COMMIT\"" || die "the pinned manifest does not name rustc $RUSTC_COMMIT"
[ "$(rustup run "$TOOLCHAIN" rustc -vV | sed -n 's/^commit-hash: //p')" = "$RUSTC_COMMIT" ] || tool_mismatch "rustc of $TOOLCHAIN is not commit $RUSTC_COMMIT"
rustup component list --toolchain "$TOOLCHAIN" --installed | grep -q '^rust-src' || rustup component add rust-src --toolchain "$TOOLCHAIN"
rustup target list --toolchain "$TOOLCHAIN" --installed | grep -q '^wasm32-unknown-unknown' || rustup target add wasm32-unknown-unknown --toolchain "$TOOLCHAIN"

# ---- Rust-built tools: from checksummed crates.io sources (cargo install --locked) ---------------
# with the pinned stable release (an installed "stable" that IS that release is used as is).
TOOLS_MANIFEST="$DL/channel-rust-$TOOLS_TOOLCHAIN.toml"
if [ ! -f "$TOOLS_MANIFEST" ] || [ "$(sha "$TOOLS_MANIFEST")" != "$TOOLS_CHANNEL_MANIFEST_SHA256" ]; then
  curl -fsSL -o "$TOOLS_MANIFEST" "https://static.rust-lang.org/dist/channel-rust-$TOOLS_TOOLCHAIN.toml"
fi
[ "$(sha "$TOOLS_MANIFEST")" = "$TOOLS_CHANNEL_MANIFEST_SHA256" ] || die "the Rust $TOOLS_TOOLCHAIN channel manifest does not match its pinned SHA-256"
grep -A2 '^\[pkg.rustc\]' "$TOOLS_MANIFEST" | grep -q "git_commit_hash = \"$TOOLS_RUSTC_COMMIT\"" || die "the pinned manifest does not name rustc $TOOLS_RUSTC_COMMIT"
TT=""
for cand in "$TOOLS_TOOLCHAIN" stable; do
  if [ "$(rustup run "$cand" rustc -vV 2>/dev/null | sed -n 's/^commit-hash: //p')" = "$TOOLS_RUSTC_COMMIT" ]; then TT=$cand; break; fi
done
if [ -z "$TT" ]; then rustup toolchain install "$TOOLS_TOOLCHAIN" --profile minimal; TT=$TOOLS_TOOLCHAIN; fi
[ "$(rustup run "$TT" rustc -vV | sed -n 's/^commit-hash: //p')" = "$TOOLS_RUSTC_COMMIT" ] || die "no Rust $TOOLS_TOOLCHAIN (commit $TOOLS_RUSTC_COMMIT) to build the tools with"
cargo_tool() { # crate version bin dir-var
  local crate=$1 version=$2 bin=$3 dir
  dir=${!4:-$WORK/tools/$crate-$version}
  if [ ! -x "$dir/bin/$bin" ]; then
    log "building $crate $version from crates.io (cargo +$TT install --locked)" >&2
    nice -n "$NICE" cargo "+$TT" install --locked --root "$dir" "$crate" --version "$version" >&2
  fi
  echo "$dir"
}
WASM_BINDGEN_DIR=$(cargo_tool wasm-bindgen-cli "$WASM_BINDGEN_VERSION" wasm-bindgen WASM_BINDGEN_DIR)
WASM_PACK_DIR=$(cargo_tool wasm-pack "$WASM_PACK_VERSION" wasm-pack WASM_PACK_DIR)
JUST_DIR=$(cargo_tool just "$JUST_VERSION" just JUST_DIR)
export PATH="$WASM_BINDGEN_DIR/bin:$WASM_PACK_DIR/bin:$JUST_DIR/bin:$PATH"
[ "$(wasm-bindgen --version | awk '{print $2}')" = "$WASM_BINDGEN_VERSION" ] || tool_mismatch "wasm-bindgen $(wasm-bindgen --version) is not the pinned $WASM_BINDGEN_VERSION"
[ "$(wasm-pack --version | awk '{print $2}')" = "$WASM_PACK_VERSION" ] || tool_mismatch "wasm-pack $(wasm-pack --version) is not the pinned $WASM_PACK_VERSION"
[ "$(just --version | awk '{print $2}')" = "$JUST_VERSION" ] || tool_mismatch "just $(just --version) is not the pinned $JUST_VERSION"

# ---- binaryen (wasm-opt): release tarball by hash ------------------------------------------------
if [ -z "${BINARYEN_DIR:-}" ]; then
  BINARYEN_DIR="$WORK/tools/binaryen-$BINARYEN_VERSION"
  if [ "$(cat "$BINARYEN_DIR/.zw-tarball-sha256" 2>/dev/null)" != "$BINARYEN_SHA256" ]; then
    TB="$DL/binaryen-$BINARYEN_VERSION-x86_64-linux.tar.gz"
    if [ ! -f "$TB" ] || [ "$(sha "$TB")" != "$BINARYEN_SHA256" ]; then
      log "downloading binaryen $BINARYEN_VERSION"
      curl -fsSL -o "$TB" "https://github.com/WebAssembly/binaryen/releases/download/$BINARYEN_VERSION/binaryen-$BINARYEN_VERSION-x86_64-linux.tar.gz"
    fi
    [ "$(sha "$TB")" = "$BINARYEN_SHA256" ] || { rm -f "$TB"; die "the binaryen tarball does not match its pinned SHA-256"; }
    rm -rf "$BINARYEN_DIR"; mkdir -p "$WORK/tools"
    tar -xzf "$TB" -C "$WORK/tools"
    echo "$BINARYEN_SHA256" > "$BINARYEN_DIR/.zw-tarball-sha256"
  fi
else
  log "using BINARYEN_DIR=$BINARYEN_DIR as given (it must be the binaryen-$BINARYEN_VERSION release whose tarball has sha256 $BINARYEN_SHA256)"
fi
export PATH="$BINARYEN_DIR/bin:$PATH"
wasm-opt --version | grep -q "${BINARYEN_VERSION#version_}" || die "wasm-opt is not binaryen $BINARYEN_VERSION" 2

# ---- sources --------------------------------------------------------------------------------------
checkout() { # repo rev dir
  if [ ! -d "$3/.git" ]; then git clone -q "$1" "$3"; fi
  git -C "$3" fetch -q origin "$2" 2>/dev/null || git -C "$3" fetch -q origin
  git -C "$3" checkout -q --detach "$2"
  git -C "$3" reset -q --hard "$2"
  git -C "$3" clean -q -fdx -e target
  [ "$(git -C "$3" rev-parse HEAD)" = "$2" ] || die "$3 is not at $2"
}
prepare_sources() {
  log "sources: WebZjs $WEBZJS_REV (librustzcash $LIBRUSTZCASH_REV, orchard $ORCHARD_REV)"
  checkout "$WEBZJS_REPO" "$WEBZJS_REV" "$WORK/WebZjs"
  for p in "$HERE"/patches/webzjs/*.diff; do
    log "applying $(basename "$p")"
    git -C "$WORK/WebZjs" apply --whitespace=nowarn "$p" || die "patch $(basename "$p") does not apply"
  done
  # The libsqlite3-sys shim: reviewed as its own directory here; 0004 adds the same files.
  local shim="$WORK/WebZjs/zw/libsqlite3-sys-shim"
  [ -d "$shim" ] || die "0004 did not add zw/libsqlite3-sys-shim"
  diff -r "$HERE/libsqlite3-sys-shim" "$shim" >/dev/null || die "the patched tree's zw/libsqlite3-sys-shim differs from libsqlite3-sys-shim/"
  rm -rf "$shim"; cp -r "$HERE/libsqlite3-sys-shim" "$shim"
  grep -q 'libsqlite3-sys *= { path = "zw/libsqlite3-sys-shim" }' "$WORK/WebZjs/Cargo.toml" || die "Cargo.toml does not patch libsqlite3-sys with the shim"
  grep -q "$LIBRUSTZCASH_REV" "$WORK/WebZjs/Cargo.toml" || die "WebZjs Cargo.toml does not pin librustzcash $LIBRUSTZCASH_REV"
  grep -q "$ORCHARD_REV" "$WORK/WebZjs/Cargo.toml" || die "WebZjs Cargo.toml does not pin orchard $ORCHARD_REV"
  grep -A3 'name = "sqlite-wasm-rs"' "$WORK/WebZjs/Cargo.lock" | grep -q "checksum = \"$SQLITE_WASM_RS_CRATE_SHA256\"" || die "Cargo.lock does not pin sqlite-wasm-rs 0.4.3 by its checksum"
  grep -q 'features = \["precompiled"\]' "$shim/Cargo.toml" || die "the shim must use sqlite-wasm-rs's precompiled feature (with OUR library, see build-sqlite.sh)"
  [ ! -e "$WORK/WebZjs/vendor/zcash_client_memory" ] || die "vendor/zcash_client_memory must not exist (Stage 2 removed the memory backend)"
}

# Map machine-specific absolute paths out of the binary (panic locations), so the same pins give
# the same bytes in any directory. The first flags repeat WebZjs's .cargo/config.toml (RUSTFLAGS
# replaces it).
wasm_rustflags() {
  local cargo_home=${CARGO_HOME:-$HOME/.cargo} rustup_home=${RUSTUP_HOME:-$HOME/.rustup}
  echo "-C target-feature=+atomics,+bulk-memory,+mutable-globals --remap-path-prefix=$WORK=/zw-build --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$rustup_home=/rustup"
}

# Fails when an output's hash differs from the expected one (when one is given).
expect_sha256() { # file expected-or-empty label
  [ -n "$2" ] || return 0
  local got
  got=$(sha "$1")
  [ "$got" = "$2" ] || die "$3: wasm sha256 $got differs from the expected $2" 4
  log "$3: wasm sha256 matches the expected $2"
}

SQLITE_LIB_DIR=""
build_sqlite() {
  [ -n "$SQLITE_LIB_DIR" ] && return 0
  TOOLCHAIN=$TOOLCHAIN NICE=$NICE "$HERE/build-sqlite.sh" "$WORK"
  SQLITE_LIB_DIR="$WORK/sqlite-wasm"
  [ -f "$SQLITE_LIB_DIR/libsqlite3.a" ] || die "build-sqlite.sh produced no library"
}

build_engine() { # main|regtest
  local variant=$1 features="" lock_before expected="" outputs
  [ "$variant" = regtest ] && features=regtest
  build_sqlite
  log "building engine ($variant), SQLite from $SQLITE_LIB_DIR/libsqlite3.a ($(sha "$SQLITE_LIB_DIR/libsqlite3.a"))"
  lock_before=$(sha "$WORK/WebZjs/Cargo.lock")
  ( cd "$WORK/WebZjs" && rm -rf packages/webzjs-wallet && \
    SQLITE_WASM_RS_PREBUILD_LD_LIB_PATH="$SQLITE_LIB_DIR" RUSTFLAGS="$(wasm_rustflags)" nice -n "$NICE" just build-wallet $features )
  [ "$(sha "$WORK/WebZjs/Cargo.lock")" = "$lock_before" ] || die "Cargo.lock changed during the build: the patches' lock file is incomplete"
  # The engine linked OUR library: sqlite-wasm-rs's build script pointed the linker at it.
  outputs=$(grep -l "rustc-link-search=native=$SQLITE_LIB_DIR\$" "$WORK"/WebZjs/target/wasm32-unknown-unknown/release/build/sqlite-wasm-rs-*/output 2>/dev/null || true)
  [ -n "$outputs" ] || die "sqlite-wasm-rs did not link $SQLITE_LIB_DIR/libsqlite3.a"
  if grep -h "rustc-link-search" "$WORK"/WebZjs/target/wasm32-unknown-unknown/release/build/sqlite-wasm-rs-*/output | grep -v "=$SQLITE_LIB_DIR\$" | grep -q .; then
    die "a sqlite-wasm-rs build points the linker at another library directory"
  fi
  rm -rf "$OUT/webzjs-wallet-$variant"; mkdir -p "$OUT"
  cp -r "$WORK/WebZjs/packages/webzjs-wallet" "$OUT/webzjs-wallet-$variant"
  rm -f "$OUT/webzjs-wallet-$variant/.gitignore"
  ( cd "$OUT/webzjs-wallet-$variant" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
  log "engine $variant: $(stat -c %s "$OUT/webzjs-wallet-$variant/webzjs_wallet_bg.wasm") bytes, sha256 $(sha "$OUT/webzjs-wallet-$variant/webzjs_wallet_bg.wasm")"
  [ "$variant" = main ] && expected=${EXPECT_MAIN_WASM_SHA256:-}
  [ "$variant" = regtest ] && expected=${EXPECT_REGTEST_WASM_SHA256:-}
  expect_sha256 "$OUT/webzjs-wallet-$variant/webzjs_wallet_bg.wasm" "$expected" "engine $variant"
}

build_helper() {
  log "building zw-tx-decrypt (Node.js)"
  rm -rf "$WORK/zw-tx-decrypt"; cp -r "$HERE/zw-tx-decrypt" "$WORK/zw-tx-decrypt"
  # EXACTLY the engine's dependency resolution: start from its Cargo.lock.
  cp "$WORK/WebZjs/Cargo.lock" "$WORK/zw-tx-decrypt/Cargo.lock"
  ( cd "$WORK/zw-tx-decrypt" && RUSTFLAGS="--remap-path-prefix=$WORK=/zw-build --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=${RUSTUP_HOME:-$HOME/.rustup}=/rustup" \
      nice -n "$NICE" wasm-pack build --target nodejs --release --out-dir pkg )
  # Cargo only dropped the engine's packages the helper does not use: no version or source differs.
  python3 -I - "$WORK/WebZjs/Cargo.lock" "$WORK/zw-tx-decrypt/Cargo.lock" <<'PY' || die "the helper's Cargo.lock differs from the engine's"
import re, sys
def pk(path):
    out = {}
    for blk in open(path).read().split("[[package]]")[1:]:
        n = re.search(r'name = "([^"]+)"', blk).group(1)
        v = re.search(r'version = "([^"]+)"', blk).group(1)
        s = re.search(r'source = "([^"]+)"', blk)
        c = re.search(r'checksum = "([^"]+)"', blk)
        out.setdefault(n, set()).add((v, s.group(1) if s else None, c.group(1) if c else None))
    return out
e, h = pk(sys.argv[1]), pk(sys.argv[2])
bad = [n for n in h if n != "zw-tx-decrypt" and not h[n] <= e.get(n, set())]
print(f"[build-engine] helper Cargo.lock: {len(h)} packages, all with the engine's version/source/checksum" if not bad else f"[build-engine] differs: {bad}")
sys.exit(1 if bad else 0)
PY
  rm -rf "$OUT/zw-tx-decrypt"; mkdir -p "$OUT/zw-tx-decrypt"
  cp "$WORK/zw-tx-decrypt/pkg/"zw_tx_decrypt* "$WORK/zw-tx-decrypt/pkg/package.json" "$OUT/zw-tx-decrypt/"
  cp "$HERE/zw-tx-decrypt/README.md" "$OUT/zw-tx-decrypt/"
  mkdir -p "$OUT/zw-tx-decrypt/test" && cp -r "$WORK/zw-tx-decrypt/test/." "$OUT/zw-tx-decrypt/test/"
  ( cd "$OUT/zw-tx-decrypt" && ZW_TX_DECRYPT_PKG="$OUT/zw-tx-decrypt/zw_tx_decrypt.js" node --test test/decrypt.test.mjs ) > "$WORK/helper-tests.log" 2>&1 || { tail -40 "$WORK/helper-tests.log"; die "helper Node tests failed"; }
  log "helper Node tests: $(grep -E '^# (pass|fail) ' "$WORK/helper-tests.log" | tr '\n' ' ')"
  ( cd "$OUT/zw-tx-decrypt" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
  log "helper: $(stat -c %s "$OUT/zw-tx-decrypt/zw_tx_decrypt_bg.wasm") bytes, sha256 $(sha "$OUT/zw-tx-decrypt/zw_tx_decrypt_bg.wasm")"
  expect_sha256 "$OUT/zw-tx-decrypt/zw_tx_decrypt_bg.wasm" "${EXPECT_HELPER_WASM_SHA256:-}" "helper"
}

prepare_sources
case "$WHAT" in
  main) build_engine main ;;
  regtest) build_engine regtest ;;
  helper) build_helper ;;
  all) build_engine main; build_engine regtest; build_helper ;;
  *) die "usage: $0 [main|regtest|helper|all] [WORK_DIR]" 2 ;;
esac
{
  echo "WebZjs $WEBZJS_REPO @ $WEBZJS_REV"
  echo "librustzcash $LIBRUSTZCASH_REV; orchard $ORCHARD_REV"
  echo "patches (applied in this order):"; for p in "$HERE"/patches/webzjs/*.diff; do echo "  $(sha "$p")  ${p#$HERE/}"; done
  echo "libsqlite3-sys shim:"; ( cd "$HERE" && find libsqlite3-sys-shim -type f | sort | xargs sha256sum | sed 's/^/  /' )
  [ -n "$SQLITE_LIB_DIR" ] && { echo "SQLite (build-sqlite.sh):"; sed 's/^/  /' "$SQLITE_LIB_DIR/PROVENANCE.txt"; }
  echo "toolchain: $(rustup run "$TOOLCHAIN" rustc --version) (channel manifest sha256 $RUST_CHANNEL_MANIFEST_SHA256); tools built with $(rustup run "$TT" rustc --version) (manifest sha256 $TOOLS_CHANNEL_MANIFEST_SHA256)"
  echo "tools: $(wasm-pack --version) (cargo install --locked); $(wasm-bindgen --version) (cargo install --locked); just $(just --version | awk '{print $2}') (cargo install --locked); $(wasm-opt --version) (tarball sha256 $BINARYEN_SHA256); node $(node --version)"
  for v in main regtest; do [ -f "$OUT/webzjs-wallet-$v/webzjs_wallet_bg.wasm" ] && echo "engine $v: wasm $(stat -c %s "$OUT/webzjs-wallet-$v/webzjs_wallet_bg.wasm") bytes, sha256 $(sha "$OUT/webzjs-wallet-$v/webzjs_wallet_bg.wasm")"; done
  [ -f "$OUT/zw-tx-decrypt/zw_tx_decrypt_bg.wasm" ] && echo "helper: wasm $(stat -c %s "$OUT/zw-tx-decrypt/zw_tx_decrypt_bg.wasm") bytes, sha256 $(sha "$OUT/zw-tx-decrypt/zw_tx_decrypt_bg.wasm")"
  echo "published engine hashes (Stage 2 engine): main $PUBLISHED_MAIN_WASM_SHA256, regtest $PUBLISHED_REGTEST_WASM_SHA256"
} > "$OUT/BUILD-INFO.txt"
log "done: $OUT"
