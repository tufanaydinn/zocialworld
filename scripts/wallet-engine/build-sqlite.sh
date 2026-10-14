#!/usr/bin/env bash
# Zocial World — SQLite for the Stage-2 wallet engine, built FROM SOURCE (ADR-018 § 3/§ 7).
#
#   build-sqlite.sh [WORK_DIR]          -> $WORK/sqlite-wasm/libsqlite3.a (+ PROVENANCE.txt)
#
# The engine reaches SQLite through rusqlite 0.37 -> the libsqlite3-sys shim (zw/libsqlite3-sys-shim)
# -> sqlite-wasm-rs 0.4.3 with its `precompiled` feature. That crate ships a prebuilt
# `sqlite3/libsqlite3.a` (made by its GitHub Actions run with emscripten "latest"). We do NOT link
# that binary. This script rebuilds it from source with a pinned toolchain, exactly the way the
# crate's own precompile workflow does, and build-engine.sh points the crate's build script at the
# result (SQLITE_WASM_RS_PREBUILD_LD_LIB_PATH, a documented override of sqlite-wasm-rs 0.4.3):
#
#   1. emscripten 4.0.12 (the release that was "latest" when the crate's library was made; its clang
#      is the LLVM commit recorded in that library's `producers` section): the release tarball is
#      checked against its pinned SHA-256 before it is unpacked.
#   2. every prebuilt system library in that release's cache is DELETED and emscripten's libc is
#      rebuilt from its sources (embuilder); the result must equal EMSCRIPTEN_LIBC_SHA256.
#   3. the sqlite-wasm-rs 0.4.3 crate is checked against its crates.io checksum (= the engine's
#      Cargo.lock), its `sqlite3.c` / `sqlite3.h` / `sqlite3ext.h` against the official SQLite
#      3.50.4 amalgamation from sqlite.org (pinned SHA-256), and its prebuilt libsqlite3.a is deleted.
#   4. the crate's build script compiles sqlite3.c + shim/wasm-shim.c with emcc (`bundled` feature,
#      the workflow's settings: release, opt-level "z"), producing libsqlite3.a.
#   5. the result must equal EXPECT_SQLITE_LIB_SHA256 (default: the SHA-256 of the prebuilt the crate
#      ships — measured 2026-10-09: our from-source build is byte-identical to it).
#
# Environment: NICE (19), TOOLCHAIN (nightly-2025-06-15), DL_CACHE (a directory holding already
# downloaded tarballs; they are checked like fresh downloads), EMSCRIPTEN_DIR (an emscripten tree
# made by THIS script; reused), EXPECT_SQLITE_LIB_SHA256 (empty = do not compare).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mkdir -p "${1:-$HERE/work}" && cd "${1:-$HERE/work}" && pwd)
NICE=${NICE:-19}
TOOLCHAIN=${TOOLCHAIN:-nightly-2025-06-15}
DL=${DL_CACHE:-$WORK/dl}
mkdir -p "$DL"

# ---- PINS --------------------------------------------------------------------------------------
SQLITE_VERSION=3.50.4
SQLITE_ZIP=sqlite-amalgamation-3500400.zip
SQLITE_ZIP_URL=https://sqlite.org/2025/$SQLITE_ZIP
SQLITE_ZIP_SHA256=1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032      # (SHA3-256 f131b68e6ba5fb891cc13ebb5ff9555054c77294cb92d8d1268bad5dba4fa2a1)
SQLITE_WASM_RS_VERSION=0.4.3
SQLITE_WASM_RS_CRATE_SHA256=0894a1b91dc660fbf1e6ea6f287562708e01ca1a18fa4e2c6dae0df5a05199c5  # = Cargo.lock checksum
EMSCRIPTEN_VERSION=4.0.12
EMSCRIPTEN_RELEASE=209b886304498eff50dd835850dc5715803401ed      # emsdk emscripten-releases-tags.json
EMSCRIPTEN_URL=https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/$EMSCRIPTEN_RELEASE/wasm-binaries.tar.xz
EMSCRIPTEN_SHA256=1c303712707a91b88f743b0ad6dd1544c289e614844396698a2510a66c5608f1   # (GCS md5 9A2AsTq4eXJohY0abGmZPg==)
EMSCRIPTEN_LLVM=7f93487862d98bf1c168babba87daf6224d8a46f
EMSCRIPTEN_LIBC_SHA256=1324fd783dd5ac979603bd68e22d4663e6ccf13281ca39441e070383d16a7315  # libc.a rebuilt from source (= the release's own)
PREBUILT_SQLITE_LIB_SHA256=8c0a39a8d467acbf2abb89315180e3f8c80f19121cba6843cd62da6911cc8a71 # sqlite-wasm-rs 0.4.3 sqlite3/libsqlite3.a
EXPECT_SQLITE_LIB_SHA256=${EXPECT_SQLITE_LIB_SHA256-$PREBUILT_SQLITE_LIB_SHA256}
# ------------------------------------------------------------------------------------------------

log() { echo "[build-sqlite] $*"; }
die() { echo "[build-sqlite] $*" >&2; exit 3; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
fetch() { # url file sha256
  local f="$DL/$2"
  if [ ! -f "$f" ] || [ "$(sha "$f")" != "$3" ]; then
    log "downloading $1"
    curl -fsSL -o "$f.part" "$1"
    mv "$f.part" "$f"
  fi
  [ "$(sha "$f")" = "$3" ] || { rm -f "$f"; die "$2 does not match its pinned SHA-256 $3"; }
  log "verified $2 (sha256 $3)"
}
for t in curl tar xz python3 node cargo rustup sha256sum; do command -v "$t" >/dev/null || die "missing tool: $t"; done

# ---- 1. emscripten (pinned toolchain) -----------------------------------------------------------
EMSDK=${EMSCRIPTEN_DIR:-$WORK/emscripten-$EMSCRIPTEN_VERSION}
if [ "$(cat "$EMSDK/.zw-tarball-sha256" 2>/dev/null)" != "$EMSCRIPTEN_SHA256" ]; then
  fetch "$EMSCRIPTEN_URL" "emscripten-$EMSCRIPTEN_VERSION-wasm-binaries.tar.xz" "$EMSCRIPTEN_SHA256"
  rm -rf "$EMSDK"; mkdir -p "$EMSDK"
  log "unpacking emscripten $EMSCRIPTEN_VERSION"
  nice -n "$NICE" tar -xJf "$DL/emscripten-$EMSCRIPTEN_VERSION-wasm-binaries.tar.xz" -C "$EMSDK"
  # 2. no prebuilt system library survives: emcc rebuilds what it needs from emscripten's sources.
  find "$EMSDK/install/emscripten/cache/sysroot/lib" -name '*.a' -delete
  rm -f "$EMSDK/install/emscripten/cache/sanity.txt"
  echo "$EMSCRIPTEN_SHA256" > "$EMSDK/.zw-tarball-sha256"
fi
cat > "$EMSDK/emscripten_config" <<EOF
LLVM_ROOT = '$EMSDK/install/bin'
BINARYEN_ROOT = '$EMSDK/install'
NODE_JS = '$(command -v node)'
EOF
export EM_CONFIG="$EMSDK/emscripten_config" EMCC_CORES=${CARGO_BUILD_JOBS:-2}
unset EM_CACHE
EMPATH="$EMSDK/install/emscripten"
"$EMSDK/install/bin/clang" --version | grep -q "$EMSCRIPTEN_LLVM" || die "emscripten's clang is not LLVM $EMSCRIPTEN_LLVM"
LIBC="$EMPATH/cache/sysroot/lib/wasm32-emscripten/libc.a"
if [ ! -f "$LIBC" ]; then
  log "building emscripten's libc from source (embuilder)"
  PATH="$EMPATH:$PATH" nice -n "$NICE" "$EMPATH/embuilder" build libc
fi
[ "$(sha "$LIBC")" = "$EMSCRIPTEN_LIBC_SHA256" ] || die "libc.a rebuilt from source has sha256 $(sha "$LIBC"), expected $EMSCRIPTEN_LIBC_SHA256"
log "emscripten $EMSCRIPTEN_VERSION libc.a from source: sha256 $EMSCRIPTEN_LIBC_SHA256 (= the release's prebuilt one)"

# ---- 3. sources: the crate (crates.io checksum) and SQLite's official amalgamation ---------------
CRATE="sqlite-wasm-rs-$SQLITE_WASM_RS_VERSION.crate"
cached=$(ls "${CARGO_HOME:-$HOME/.cargo}"/registry/cache/*/"$CRATE" 2>/dev/null | head -1 || true)
if [ -n "$cached" ] && [ ! -f "$DL/$CRATE" ]; then cp "$cached" "$DL/$CRATE"; fi
fetch "https://static.crates.io/crates/sqlite-wasm-rs/$CRATE" "$CRATE" "$SQLITE_WASM_RS_CRATE_SHA256"
fetch "$SQLITE_ZIP_URL" "$SQLITE_ZIP" "$SQLITE_ZIP_SHA256"
SRC="$WORK/sqlite-wasm-rs-src"
rm -rf "$SRC" "$WORK/sqlite-amalgamation"; mkdir -p "$SRC" "$WORK/sqlite-amalgamation"
tar -xzf "$DL/$CRATE" -C "$SRC"
CDIR="$SRC/sqlite-wasm-rs-$SQLITE_WASM_RS_VERSION"
python3 -I -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$DL/$SQLITE_ZIP" "$WORK/sqlite-amalgamation"
for f in sqlite3.c sqlite3.h sqlite3ext.h; do
  cmp -s "$CDIR/sqlite3/$f" "$WORK/sqlite-amalgamation/sqlite-amalgamation-3500400/$f" || die "$f in the crate differs from SQLite $SQLITE_VERSION's official amalgamation"
done
log "sqlite3.c/.h/ext.h in the crate = the official SQLite $SQLITE_VERSION amalgamation (sqlite3.c sha256 $(sha "$CDIR/sqlite3/sqlite3.c"))"
[ "$(sha "$CDIR/sqlite3/libsqlite3.a")" = "$PREBUILT_SQLITE_LIB_SHA256" ] || die "the crate's prebuilt library is not the one this script was pinned against"
rm -f "$CDIR/sqlite3/libsqlite3.a"   # the prebuilt binary is never used

# ---- 4. compile (the crate's own `bundled` build script; settings of its precompile workflow) ----
log "compiling SQLite $SQLITE_VERSION with emcc $EMSCRIPTEN_VERSION"
(
  cd "$CDIR"
  unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS SQLITE_WASM_RS_PREBUILD_LD_LIB_PATH
  PATH="$EMPATH:$PATH" CARGO_TARGET_DIR="$WORK/sqlite-wasm-rs-target" CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
    SQLITE_WASM_RS_UPDATE_PREBUILD=1 nice -n "$NICE" \
    cargo "+$TOOLCHAIN" build --locked --release --target wasm32-unknown-unknown --features bundled
)
[ -f "$CDIR/sqlite3/libsqlite3.a" ] || die "the crate's build script produced no libsqlite3.a"
OUTD="$WORK/sqlite-wasm"
rm -rf "$OUTD"; mkdir -p "$OUTD"
cp "$CDIR/sqlite3/libsqlite3.a" "$OUTD/libsqlite3.a"
GOT=$(sha "$OUTD/libsqlite3.a")
log "libsqlite3.a from source: $(stat -c %s "$OUTD/libsqlite3.a") bytes, sha256 $GOT"
if [ -n "$EXPECT_SQLITE_LIB_SHA256" ]; then
  [ "$GOT" = "$EXPECT_SQLITE_LIB_SHA256" ] || die "libsqlite3.a sha256 $GOT differs from the expected $EXPECT_SQLITE_LIB_SHA256"
  log "matches the expected $EXPECT_SQLITE_LIB_SHA256$([ "$GOT" = "$PREBUILT_SQLITE_LIB_SHA256" ] && echo " (byte-identical to the crate's prebuilt library)")"
fi
cat > "$OUTD/PROVENANCE.txt" <<EOF
libsqlite3.a  sha256 $GOT  ($(stat -c %s "$OUTD/libsqlite3.a") bytes)
SQLite $SQLITE_VERSION, official amalgamation $SQLITE_ZIP (sha256 $SQLITE_ZIP_SHA256) = sqlite-wasm-rs $SQLITE_WASM_RS_VERSION sqlite3/
compiled by sqlite-wasm-rs $SQLITE_WASM_RS_VERSION's build script (feature bundled, release, opt-level z), crate sha256 $SQLITE_WASM_RS_CRATE_SHA256
emscripten $EMSCRIPTEN_VERSION (release $EMSCRIPTEN_RELEASE, tarball sha256 $EMSCRIPTEN_SHA256, clang LLVM $EMSCRIPTEN_LLVM)
emscripten libc.a rebuilt from source: sha256 $EMSCRIPTEN_LIBC_SHA256
the crate's prebuilt sqlite3/libsqlite3.a (sha256 $PREBUILT_SQLITE_LIB_SHA256) was deleted before the build$([ "$GOT" = "$PREBUILT_SQLITE_LIB_SHA256" ] && echo "; the from-source library is byte-identical to it")
EOF
log "done: $OUTD/libsqlite3.a"
