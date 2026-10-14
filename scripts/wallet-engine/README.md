# Zocial World wallet engine — reproducible build, Stage 2 "Ironwood" (ADR-018 § 3, § 7)

This directory rebuilds, from pinned public sources plus our patch files, exactly what the game
ships for the mainnet wallet (the Stage 2 engine):

| Output | What | Used by |
|---|---|---|
| `webzjs-wallet-main/` | the in-game wallet engine (WebAssembly, browser): upstream `zcash_client_sqlite` in wasm, Ironwood + Sapling + legacy Orchard + transparent | the web client, mainnet builds (`vendor/webzjs-wallet-main/`) |
| `webzjs-wallet-regtest/` | the same engine whose `"test"` network is a local regtest chain (every upgrade through NU6.3 at height 1) | **testing only**, never deployed |
| `zw-tx-decrypt/` | Node.js helper 0.2: trial-decrypts a transaction with the registry/fee viewing key (Sapling, Orchard and **Ironwood** outputs); registry addresses (full UA, shielded UA, Stage-1 UA, zs1, t1) | the game server, name fee § 5 and transfer fee § 6 (`vendor/zcash-tx-decrypt/`) |

`API.md` is the engine's API for the game (API-v2, the contract the client adapter follows:
`apps/web/src/zcash/core/wallet.ts`).

## Getting the engine binary

`vendor/webzjs-wallet-main/` holds the package's JavaScript glue, TypeScript types, worker snippets,
`SHA256SUMS`, `BUILD-INFO.txt`, `PROVENANCE.md` and the licence texts. The 62 MB WebAssembly module
`webzjs_wallet_bg.wasm` is not in git; it is published as an asset of a GitHub Release. A `test`
build does not need it (the client then uses a stand-in engine and the wallet panel says the engine is
not installed); a `main` build always does. Two ways to get it:

1. **Fetch the published binary** (seconds):

   ```sh
   npm run engine:fetch
   ```

   `fetch-engine.mjs` downloads `webzjs_wallet_bg.wasm` from the Release
   `https://github.com/tufanaydinn/zocialworld/releases/tag/engine-<id>` into `vendor/webzjs-wallet-main/`,
   where `<id>` is the first 12 hex digits of the module's SHA-256 in `vendor/webzjs-wallet-main/SHA256SUMS`
   (for this engine: tag `engine-772d260643a8`). It checks the download against `SHA256SUMS` and refuses
   (deleting the download) on any difference, so the binary you get is always the one the committed
   checksums name. `--force` downloads again even when a matching file is present; `--url <url>` uses
   another location (a mirror) and is checked the same way.

2. **Build it from source** (70-90 minutes, ≈ 10 GB of disk; see below):

   ```sh
   scripts/wallet-engine/build-engine.sh main /some/empty/dir
   cp /some/empty/dir/out/webzjs-wallet-main/webzjs_wallet_bg.wasm vendor/webzjs-wallet-main/
   ```

**Confirming the hash.** Whichever way you got it, the module must match the committed checksum:

```sh
cd vendor/webzjs-wallet-main && sha256sum -c --ignore-missing SHA256SUMS
# webzjs_wallet_bg.wasm: OK   (sha256 772d260643a874e261e5067324243b255194b90d2c91d0513e4b6ac0a25e3854)
```

A rebuild with `EXPECT_MAIN_WASM_SHA256` set fails unless it produces exactly the published bytes
(see "Confirming the vendored build" below), so the Release asset can be checked against the sources.

## Building

```sh
./build-engine.sh all  [WORK_DIR]      # main + regtest + helper (~70-90 min on a shared 4-vCPU machine from scratch)
./build-engine.sh main [WORK_DIR]      # just the shippable engine
./build-engine.sh helper [WORK_DIR]    # just the server helper (runs its Node tests)
./build-sqlite.sh [WORK_DIR]           # just SQLite from source (build-engine.sh calls it)
./verify-reproducible.sh --build WORK_A WORK_B [main|all]   # two independent builds, byte-identical or exit 1
./verify-reproducible.sh OUT_A OUT_B                        # compare two finished outputs
```

Outputs land in `$OUT` (default `WORK_DIR/out`, `WORK_DIR` default `work/`, git-ignored), each package
with a `SHA256SUMS`; `BUILD-INFO.txt` records every pin, patch hash, the SQLite provenance and the tool
versions. Run heavy builds with `nice -n 19` and `CARGO_BUILD_JOBS=2` on a shared machine.

**Confirming the vendored build:** set the published hashes and build; the script fails on any difference:

```sh
EXPECT_MAIN_WASM_SHA256=772d260643a874e261e5067324243b255194b90d2c91d0513e4b6ac0a25e3854 \
EXPECT_REGTEST_WASM_SHA256=768907a2c2317225aea50c6707dc612a5046920b679b72750968ed3112a4bf1b \
EXPECT_HELPER_WASM_SHA256=4ff4b6c095c7e6397ae3a3c48ea5d22615f623f5046e14a765806647b9590804 \
  ./build-engine.sh all /some/empty/dir
```

`EXPECT_SQLITE_LIB_SHA256` (default: the hash of sqlite-wasm-rs 0.4.3's own library, see below) does
the same for the from-source SQLite library; set it empty to skip that comparison.

## Sources and patches

| Source | Pin |
|---|---|
| WebZjs | `ZcashCommunityGrants/WebZjs` @ `bdbc6f2f9e8c60f722c73ca7c83b48b861428f70` (red.dev's NU6.3 port) |
| librustzcash | `zcash/librustzcash` @ `0a2c6d1ae6274e6af2291e312f7b7459516882f2` (every crate, incl. `zcash_client_sqlite` 0.22.0-rc.1), via WebZjs `Cargo.toml` `[patch.crates-io]` + `Cargo.lock` |
| orchard | `zcash/orchard` @ `3bd2b736d1273226595773265313fc3f3428af16` |
| crates.io / git dependencies | `Cargo.lock` (checksums, revisions); the build fails if `Cargo.lock` changes |

`patches/webzjs/`, applied in file-name order (each must apply cleanly, else the build stops):

| Patch | sha256 | What |
|---|---|---|
| `0001-shielded-memo-zip321-fix.diff` | `939a6098…` | Stage 1: memos on shielded transfers (`propose_transfer` takes a memo) and the zip321 0.9 fix |
| `0002-regtest-test-network-feature.diff` | `fa73baf2…` | Stage 1: the `regtest` cargo feature (off in the shipped build) |
| `0003-sapling-beta-engine.diff` | `161a64d9…` | Stage 1: the Sapling beta engine (addresses, in-engine shielding, the one general `send`, the consensus-branch guard, coded errors) |
| `0004-ironwood-sqlite-receive.diff` | `de5b878d…` | Stage 2, first step: `zcash_client_sqlite` in wasm through the libsqlite3-sys shim, Ironwood receive side |
| `0005-ironwood-sqlite-engine.diff` | `d365fd01…` | Stage 2: the full Stage-1 API on SQLite, Stage-2 pool policy, Ironwood change, history, memos, lock discipline, compaction; removes `zcash_client_memory`; the TEX one-time-address UTXO check, stable addresses, shielding one source at a time, damaged saves refused with a code |

The full hashes are in `vendor/webzjs-wallet-main/BUILD-INFO.txt`. The patches are applied on top of
`bdbc6f2`; 0001-0003 carry the Stage 1 engine, 0004-0005 move it to the SQLite backend. The Stage 1
engine's memory-backend patch is not part of this build: the script refuses to build if
`vendor/zcash_client_memory` exists in the WebZjs checkout.

The patch comments are compiled into the wasm as `file:line` locations (tracing and panic messages), so
a comment edit that adds or removes lines changes the binary; an edit within lines does not, which
`EXPECT_MAIN_WASM_SHA256` confirms.

`libsqlite3-sys-shim/` is the 30-line `libsqlite3-sys` 0.35 package that lets rusqlite 0.37 (the
version `zcash_client_sqlite` pins) run on `wasm32-unknown-unknown`: on wasm it re-exports
`sqlite-wasm-rs =0.4.3` (feature `precompiled`, see below), natively the real `libsqlite3-sys`
0.36 (bundled) for the unit tests. 0004 adds it at `WebZjs/zw/libsqlite3-sys-shim`, where
`Cargo.toml` `[patch.crates-io]` points. It is kept here as its own directory for review;
`build-engine.sh` installs it there and fails if it differs from what 0004 added.

`zw-tx-decrypt/` is the helper's source (0.2.0); it is built with the engine's own `Cargo.lock`
(the script checks that every package the helper uses has the engine's exact version, source and
checksum).

## Licences

WebZjs, librustzcash and orchard are MIT OR Apache-2.0, and so are our patches and `zw-tx-decrypt`.
`vendor/webzjs-wallet-main/` ships WebZjs's `LICENSE-MIT` and `LICENSE-APACHE` and a
`THIRD-PARTY-NOTICES.md` for every crate compiled into the module; `vendor/zcash-tx-decrypt/` ships its
own `THIRD-PARTY-NOTICES.md`. Both notices files are generated by `third-party-notices.mjs` from the
build's own checkout and `Cargo.lock` (`cargo tree` for the shipped target and features, `cargo metadata`
and the licence files in each crate's source):

```sh
node third-party-notices.mjs WORK_DIR/WebZjs webzjs-wallet wasm32-unknown-unknown \
  --no-default-features --features wasm,wasm-parallel > ../../vendor/webzjs-wallet-main/THIRD-PARTY-NOTICES.md
node third-party-notices.mjs WORK_DIR/zw-tx-decrypt zw-tx-decrypt > ../../vendor/zcash-tx-decrypt/THIRD-PARTY-NOTICES.md
```

SQLite is in the public domain.

## SQLite: built from source with a pinned toolchain

**SQLite is built from source with a pinned emscripten; the engine stays on sqlite-wasm-rs 0.4.3 +
wasm-bindgen 0.2.100.** sqlite-wasm-rs 0.4.3 ships a prebuilt `sqlite3/libsqlite3.a` made by its
GitHub Actions run (emscripten "latest", Rust 1.78, `opt-level=z`). The engine no longer links that
binary:

1. `build-sqlite.sh` downloads **emscripten 4.0.12** (release `209b8863…`, the "latest" emsdk
   alias on the day that library was built; its clang is LLVM `7f934878…`, the commit recorded in
   the library's `producers` section) and checks the tarball's SHA-256 (`1c303712…`).
2. It **deletes every prebuilt system library** in that release's cache and rebuilds emscripten's
   libc from its sources (`embuilder build libc`). Result: `libc.a` sha256 `1324fd78…`, identical
   to the release's own (checked).
3. It checks the sqlite-wasm-rs 0.4.3 crate against its crates.io checksum (`0894a1b9…`, the value
   in `Cargo.lock`), checks that its `sqlite3.c`, `sqlite3.h`, `sqlite3ext.h` are **byte-identical
   to the official SQLite 3.50.4 amalgamation** from sqlite.org (`sqlite-amalgamation-3500400.zip`,
   sha256 `1d3049dd…`), and deletes the crate's prebuilt `libsqlite3.a`.
4. It runs the crate's own build script in its `bundled` mode with the workflow's settings: emcc
   compiles `sqlite3.c` + `shim/wasm-shim.c` (+ emscripten's libc) into `libsqlite3.a`.
5. The result must equal `EXPECT_SQLITE_LIB_SHA256`. **Measured: our from-source library is
   byte-identical to the prebuilt one** (`8c0a39a8d467acbf2abb89315180e3f8c80f19121cba6843cd62da6911cc8a71`,
   1,351,992 bytes) — in every build so far. So the prebuilt object is now verified, and the
   engine is built from source regardless.

`build-engine.sh` then sets `SQLITE_WASM_RS_PREBUILD_LD_LIB_PATH` (a documented override of
sqlite-wasm-rs 0.4.3's build script) to the from-source library's directory, and after each engine
build checks the crate's build-script output: the linker searched **only** that directory.

**Why not sqlite-wasm-rs 0.5 + wasm-bindgen ≥ 0.2.104 now.** 0.5.1 and later compile SQLite 3.51–3.53
with plain clang (no prebuilt object), but need wasm-bindgen ≥ 0.2.104 / js-sys ≥ 0.3.81: new generated
glue and thread plumbing, a newer SQLite and a new shim mapping — a different engine that would need
the full verification again. Revisit with NU7, when the engine is rebuilt and re-verified anyway.

## What is pinned: every downloaded tool, by content

| Tool / input | Pin | How it is checked |
|---|---|---|
| Rust `nightly-2025-06-15` (+ `rust-src`, `wasm32-unknown-unknown`) | channel manifest sha256 `84c95b36…`; rustc commit `49a8ba06848f…` | manifest hash checked; rustup verifies each component against that manifest; the installed rustc must be that commit |
| Rust `1.97.0` (compiles the three tools below only) | manifest sha256 `3804d266…`; rustc `2d8144b7880597b6…` | same |
| wasm-bindgen-cli `0.2.100` (= the `wasm-bindgen` crate in `Cargo.lock`) | crates.io sources + the crate's own `Cargo.lock` | `cargo install --locked`, version checked |
| wasm-pack `0.15.0` | same | `cargo install --locked`, version checked |
| just `1.58.0` (runs WebZjs's `build-wallet` recipe) | same | `cargo install --locked`, version checked |
| binaryen `version_117` (`wasm-opt`) | tarball sha256 `3dc67700…` | checked before unpacking |
| emscripten `4.0.12` | tarball sha256 `1c303712…`; clang LLVM `7f934878…`; rebuilt `libc.a` sha256 `1324fd78…` | checked before unpacking; prebuilt system libraries deleted |
| SQLite `3.50.4` | official amalgamation zip sha256 `1d3049dd…` | the crate's C sources must equal it |
| sqlite-wasm-rs `0.4.3` | crate sha256 `0894a1b9…` (= `Cargo.lock`) | checked; its prebuilt library is deleted and not used |
| Node.js | any (runs the helper's tests and emscripten's tool scripts; touches no shipped byte) | version recorded |

`DL_CACHE=<dir>` reuses already downloaded tarballs; every file is still checked against its pin.
`BINARYEN_DIR`, `WASM_BINDGEN_DIR`, `WASM_PACK_DIR`, `JUST_DIR` reuse existing installs (version
checked); `ALLOW_TOOL_MISMATCH=1` continues with another version, with a warning (unpinned test
builds only). Machine paths are mapped out of the binaries (`--remap-path-prefix`), so the same pins
give the same bytes in any directory. Prerequisites: rustup, node, python3, curl, xz; ≈ 1 GB for
emscripten (348 MB download).

## Reproducibility

`verify-reproducible.sh --build WORK_A WORK_B all` builds twice, in two different directories (fresh
clones, empty `target/`, tools built in each), runs the second build with `EXPECT_*_WASM_SHA256` set
to the first build's hashes, then compares every file. Two such builds of the engine sources
(before the last, comment-only edit of the patch text) gave:

| Output | Build A | Build B | Vendored |
|---|---|---|---|
| `webzjs-wallet-main` wasm | `772d2606…` 62,478,361 B | identical (11/11 files) | identical (`vendor/webzjs-wallet-main/`; the wasm itself is the Release asset) |
| `webzjs-wallet-regtest` wasm | `768907a2…` 62,478,481 B | identical (11/11 files) | — (testing only) |
| SQLite `libsqlite3.a` from source | `8c0a39a8…` | identical | = the prebuilt in sqlite-wasm-rs 0.4.3 |

After the patch comments were last edited (text within lines only, no line added or removed), the
engine was rebuilt from the current patches with `EXPECT_MAIN_WASM_SHA256` / `EXPECT_REGTEST_WASM_SHA256`
set: main `772d2606…` and regtest `768907a2…`, byte-identical. Only the doc comments in the generated
`webzjs_wallet.js` / `.d.ts` changed, and the vendored glue, `SHA256SUMS` and `BUILD-INFO.txt` come
from that build. The helper's build adds `--remap-path-prefix`
for the Rust toolchain directory and has a neutral build-info string; its current hash
(`4ff4b6c095c7e6397ae3a3c48ea5d22615f623f5046e14a765806647b9590804`) is in `vendor/zcash-tx-decrypt/PROVENANCE.md`.

## Verification harness (`harness/`, `fixtures/`) — TESTING ONLY

The live checks the Stage-2 engine passed, so a rebuild can be re-verified the same way. The regtest
package and the fixture keys are never deployed; the fixture seeds are public regtest test keys
(REGTEST ONLY — never fund any address derived from them, on any network).

| File | What |
|---|---|
| `harness/server.mts` | serves a built engine package (and optionally a second one at `/pkg2/`) + a test page with cross-origin isolation, mounts the game's own wallet bridge (`apps/server/src/zcash/lwdProxy.ts`); regtest extras: `/__ctl/mine`, a forged `GetLightdInfo` branch (`/__ctl/lightd`), fault injection on any bridge method (`/__ctl/fault`), `/__ctl/mempool` |
| `harness/run-regtest.mjs`, `regtest.html` | the full regtest matrix (115 checks: 100 in the page, 15 helper checks on every transaction): every Stage-2 flow + the Stage-1 save → `wallet_format_unsupported` → restore from seed + birthday flow, then the helper checks on every transaction; writes the fixtures. The Stage-1 step needs a regtest build of the Stage 1 engine (its second argument), which this directory does not build |
| `harness/run-server-checks.mjs`, `server-checks.html` | the GAME SERVER's own fee and name checks end to end on the local chain: modes `sapling-registry` (Sapling fee outputs) and `full-ua-registry` (Ironwood fee outputs, the registry address `scripts/tools/registry-keys.mjs` prints). Run after `run-regtest.mjs` |
| `harness/run-mainnet.mjs`, `mainnet.html` | the mainnet smoke test without funds, through the game server's bridge (26 checks) |
| `harness/run-testnet.mjs`, `testnet.html` | the NU7 safety net on the public Testnet (NU7 active): `consensus_branch_mismatch`, refused sends, sync and balances working, restore (12 checks) |
| `harness/stage1-save.html` | makes a REAL Stage-1 save with a Stage-1 engine (for the refusal check) |
| `harness/chain/` | `env.sh` (set `ZW_CHAIN_BIN` = zebrad 6.4.2 + lightwalletd v0.5.4, `ZW_CHAIN_DIR` = chain data), `reset.sh <A t> <B UA> <C t>`, `zebrad-start.sh`, `lwd-start.sh`, `stop.sh` |
| `fixtures/` | regtest transactions, seeds and addresses (`fixtures/README.md`) |

Environment: `ZW_REPO` (default: this repository), `HELPER` (default
`vendor/zcash-tx-decrypt/zw_tx_decrypt.js`), the ports in each runner's header. The runners write
their records to `work/harness/` (git-ignored) unless given an output path.

## Moving to NU7

Facts as of 2026-10-09 (ZIP 259, ZIP 218, librustzcash `main`):

* NU7 consensus branch id **`0x77190AD9`**; Testnet activation **4,465,026** (active since
  2026-10-04); Mainnet height to be fixed around **2026-10-20** (activation expected ≈ **2026-11-05**).
* No new transaction format: v4 becomes invalid, **v5 and v6 stay valid**. The Stage-2 engine builds
  v6 transactions, so its transaction *shape* does not change — but every signature commits to the
  branch id, so the NU6.3 build cannot sign for NU7. The branch guard catches exactly that (verified
  on the public Testnet with `harness/run-testnet.mjs`).
* Block target spacing 75 s → **25 s**; default expiry delta 40 → **120** blocks (ZIP 218);
  per-block action limits; `MAX_REORG_LENGTH` 99 → 600.
* librustzcash `main` @ `eb3e586765236a808dc82eee85f2be47e11e48c6` already has `BranchId::Nu7`
  with the Testnet height and Mainnet `None`, in a new major series (`zcash_client_backend 0.25`,
  `zcash_client_sqlite 0.23.0-pre.1`, `zcash_primitives 0.31`, `orchard 0.16`, rand 0.10). A Stage 2
  test build compiled `zcash_client_sqlite` at that rev for wasm **with this same shim**.

### Steps

1. **Upstream revisions.** Wait for (or make) a librustzcash revision with the **Mainnet** NU7
   height. On a WebZjs checkout at `bdbc6f2` with 0001-0005 applied and committed, bump every
   `[patch.crates-io]` librustzcash entry (including `zcash_client_sqlite`) to that ONE rev and
   `orchard` to the rev librustzcash uses; `cargo update -p` those crates only; check `cargo tree -d`
   shows no duplicate `zcash_primitives` / `orchard` / `sapling-crypto` / `zcash_protocol`. Port the
   engine to the new APIs. Write the result as `patches/webzjs/0006-nu7.diff`
   (`git diff --binary --full-index <that commit>`) and check it applies after 0005 and reproduces the tree.
2. **Engine constants** (`crates/webzjs-wallet/src/policy.rs`):
   * `SUPPORTED_BRANCHES = &[BranchId::Nu6_3, BranchId::Nu7]`, `EXPECTED_BRANCH = BranchId::Nu7`. The
     guard works per height (lightwalletd's branch must be supported **and** equal
     `BranchId::for_height(tip)`; sending pauses while a known or announced upgrade activates within
     `UPGRADE_GUARD_BLOCKS + 1` blocks), so the NU7 build keeps sending on NU6.3 before activation,
     pauses only for the last blocks, and sends on NU7 afterwards: deploy it as soon as its
     librustzcash knows the Mainnet height.
   * `UPGRADE_GUARD_BLOCKS` = the builder's expiry delta after NU7 (**120** per ZIP 218; check
     librustzcash's `DEFAULT_TX_EXPIRY_DELTA` at the chosen rev).
   * Keep `TX_VERSION = TxVersion::V6`.
   * The regtest twin activates every upgrade at height 1 (NU7 too once compiled in); keep the
     `ZW_REGTEST_NU6_3_HEIGHT` switch and add an NU7 one for the hand-over chain.
3. **Helper** (`zw-tx-decrypt/`): same `[patch.crates-io]` revs, `Net::Regtest` with NU7 at height 1,
   update `buildInfo()`.
4. **SQLite / shim.** If the new `zcash_client_sqlite` still pins rusqlite 0.37, nothing changes here.
   If it moves to rusqlite ≥ 0.38 (sqlite-wasm-rs 0.5), drop the shim's `precompiled` path, pin a
   clang/LLVM release by hash, and bump wasm-bindgen (≥ 0.2.104) with js-sys / web-sys together.
5. **Build:** update the pins at the top of `build-engine.sh` (`LIBRUSTZCASH_REV`, `ORCHARD_REV`,
   `PUBLISHED_*`), then `./verify-reproducible.sh --build WORK_A WORK_B all`.
6. **Test locally** with zebrad ≥ 7.0.0-rc.0 and lightwalletd v0.5.4: a chain with NU7 at height 1
   (`harness/chain/zebrad-start.sh` activation heights) → `run-regtest.mjs` and both
   `run-server-checks.mjs` modes; a **hand-over chain** (NU6.3 at 1, NU7 at 300): sending allowed
   below ≈ 300 − 121, paused until 300, allowed again on `77190ad9`.
7. **Public Testnet** (`run-testnet.mjs`, now expecting `allowed: true` on `77190ad9`); fund the
   wallet from a faucet and run shield, a payment with a fee output, a name fee and a withdrawal.
8. **Mainnet smoke without funds** (`run-mainnet.mjs`): allowed on `37a5165b` before activation,
   `pendingUpgrade: { name: "NU7", height }` once announced.
9. **Game:** vendor the package and the helper (update both `PROVENANCE.md`), publish the new
   `webzjs_wallet_bg.wasm` as the Release asset `fetch-engine.mjs` expects (tag `engine-<first 12 hex
   digits of its SHA-256>`), set
   `NU7_ACTIVATION_HEIGHT` in `apps/web/src/zcash/birthday.ts` (import-date estimator) and on the
   server (`NU7_ACTIVATION_HEIGHT`: the transfer-fee check then uses 121 = 120 + 1 expiry blocks
   near and after activation).
10. **Deploy before the Mainnet activation height.** Players get the new engine on their next page
    load ("Update ready — reload", ADR-018 § 7); their saved SQLite wallet is unchanged (no format
    change at NU7). If the deploy is late, the old build's guard pauses sending and balances stay visible.

## History

- **Stage 1 ("Sapling beta", 2026-10-08):** the `zcash_client_memory` backend, patches 0001-0003 plus
  a memory-backend patch, and a 54-check harness.
- **Stage 2 ("Ironwood", 2026-10-09):** the `zcash_client_sqlite` backend (patches 0004-0005), the
  reproducible build with SQLite from source, the harness above and zw-tx-decrypt 0.2.
