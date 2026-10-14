# vendor/webzjs-wallet-main — provenance

The **mainnet** in-game wallet engine, **Stage 2 ("Ironwood")** of ADR-018 (§ 3 and the § 1 Stage 2
amendment). It replaced the Stage-1 "Sapling beta" engine. The web build copies it to `dist/webzjs/`
when `VITE_ZCASH_NETWORK=main` (`apps/web/vite.config.ts`); a `test` build uses a test-network engine
in `vendor/webzjs-wallet/` when one is installed there, and otherwise the stand-in engine (the wallet
panel then reports that the engine is not installed).

**The WebAssembly module is not in git.** `webzjs_wallet_bg.wasm` (62 MB) is published as an asset of
the GitHub Release `engine-772d260643a8` (the tag is `engine-` + the first 12 hex digits of the module's
SHA-256). `npm run engine:fetch` (`scripts/wallet-engine/fetch-engine.mjs`) downloads it into this
directory and refuses it unless it matches `SHA256SUMS`; `scripts/wallet-engine/build-engine.sh main`
rebuilds it from source. Everything else in this directory is committed.

| | |
|---|---|
| Upstream | ChainSafe WebZjs, via the Zcash Community Grants fork (red.dev's NU6.3 port) |
| Source repository | https://github.com/ZcashCommunityGrants/WebZjs |
| Source revision | `bdbc6f2f9e8c60f722c73ca7c83b48b861428f70` + the five patches below |
| Wallet database | upstream **`zcash_client_sqlite` 0.22.0-rc.1** (librustzcash, below) in WebAssembly, through rusqlite 0.37 and a 30-line `libsqlite3-sys` shim over **sqlite-wasm-rs 0.4.3** (SQLite **3.50.4**, in-memory VFS). The Stage-1 memory backend (`zcash_client_memory`) is gone |
| librustzcash | `0a2c6d1ae6274e6af2291e312f7b7459516882f2` (zcash_client_backend 0.24.0-rc.1, zcash_client_sqlite 0.22.0-rc.1, zcash_primitives 0.29, zcash_protocol 0.10) |
| orchard | `3bd2b736d1273226595773265313fc3f3428af16` |
| Consensus branch | NU6.3 `0x37A5165B` (the engine refuses to send on any other branch: `sending_status()`) |
| Transactions | version 6 (ZIP 229), Ironwood bundle; an Orchard bundle only to spend legacy Orchard notes |
| Licence | MIT OR Apache-2.0, as upstream (`package.json`, `LICENSE-MIT`, `LICENSE-APACHE`); bundled crates: `THIRD-PARTY-NOTICES.md`; SQLite is public domain |
| Package name | `@zcashcommunitygrants/webzjs-wallet` (the game imports it under its `@chainsafe/webzjs-wallet` alias) |
| Built | by `scripts/wallet-engine/build-engine.sh` (reproducible build), **twice in two independent directories, byte-identical**; rebuilt again from the current patch files with the published hash expected, byte-identical |
| Toolchain | rustc 1.89.0-nightly (49a8ba068 2025-06-14, channel manifest sha256 `84c95b36…`); tools built with rustc 1.97.0 (manifest `3804d266…`): wasm-pack 0.15.0, wasm-bindgen-cli 0.2.100, just 1.58.0 (`cargo install --locked`); binaryen version_117 (tarball sha256 `3dc67700…`); emscripten 4.0.12 (tarball `1c303712…`) for SQLite |

## Our patches (applied in order)

All five are in `scripts/wallet-engine/patches/webzjs/` (sha256 in `BUILD-INFO.txt`):

1. `0001-shielded-memo-zip321-fix.diff` (`939a6098…`) — Stage 1: memos on shielded transfers
   (`propose_transfer` takes a memo) and the zip321 0.9 fix.
2. `0002-regtest-test-network-feature.diff` (`fa73baf2…`) — Stage 1: a `regtest` cargo feature, **off** in this build.
3. `0003-sapling-beta-engine.diff` (`161a64d9…`) — Stage 1: the Sapling-beta engine (addresses,
   in-engine shielding, the one general `send`, the consensus-branch guard, coded errors, transaction ids
   on broadcast errors, the reconcile of transparent outputs spent by another wallet). Its Sapling-only
   policy is replaced by 0005.
4. `0004-ironwood-sqlite-receive.diff` (`de5b878d…`) — Stage 2, first step: `zcash_client_sqlite` in wasm
   through the libsqlite3-sys shim (`scripts/wallet-engine/libsqlite3-sys-shim/`), the Ironwood receive side.
5. `0005-ironwood-sqlite-engine.diff` (`d365fd01…`) — Stage 2: the whole Stage-1 API on SQLite;
   the Stage-2 pool policy (spends Ironwood, Sapling and legacy Orchard notes; pays Ironwood to any UA
   with an Orchard-family receiver, Sapling to `zs1`, `t1` and TEX (ZIP 320, two transactions) only as
   withdrawals; change and shielding always to Ironwood), v6 transactions, history from
   `v_transactions`, memos and statuses through `transaction_data_requests`, `check_witnesses`, one
   database lock with a nested-lock refusal, database compaction, and the Stage-1-save refusal
   (`wallet_format_unsupported`). Removes `zcash_client_memory`. Also: the TEX one-time-address check
   is answered from the UTXO set as well, so a pair whose second transaction never got mined comes back
   as shieldable after its expiry; `get_addresses` is always the account's default address; shielding
   takes one source at a time (the regular t-addresses, or one one-time address); damaged saves (bad
   page size, truncated, corrupt) give `wallet_format_unsupported` before sqlite-wasm-rs sees them.

The API the game uses is `scripts/wallet-engine/API.md` (API-v2); `webzjs_wallet.d.ts` has the typed
interfaces (`Wallet*`, with the Stage-1 `SaplingBeta*` names kept as aliases).

## SQLite provenance

SQLite 3.50.4 comes from sqlite-wasm-rs 0.4.3 (crate sha256 `0894a1b9…`, = `Cargo.lock`). The build
does **not** link the crate's prebuilt `libsqlite3.a`: `scripts/wallet-engine/build-sqlite.sh` checks
that the crate's `sqlite3.c` / `sqlite3.h` / `sqlite3ext.h` are byte-identical to the official
amalgamation `sqlite-amalgamation-3500400.zip` (sha256 `1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032`),
deletes every prebuilt emscripten system library and rebuilds emscripten 4.0.12's libc from source
(`libc.a` sha256 `1324fd78…`), deletes the crate's prebuilt library and compiles SQLite again. The
from-source `libsqlite3.a` (sha256 `8c0a39a8d467acbf2abb89315180e3f8c80f19121cba6843cd62da6911cc8a71`,
1,351,992 bytes) is byte-identical to the crate's prebuilt one — so that binary is verified, and
this engine links ours. Why not sqlite-wasm-rs 0.5 yet: `scripts/wallet-engine/README.md` § SQLite.

## Integrity

`SHA256SUMS` is the build's own list of every file of the package (`sha256sum -c SHA256SUMS` in this
directory once the module is fetched; `sha256sum -c --ignore-missing SHA256SUMS` before). The
WebAssembly module:

```
webzjs_wallet_bg.wasm  62,478,361 bytes
sha256 772d260643a874e261e5067324243b255194b90d2c91d0513e4b6ac0a25e3854
```

(+1.89 MB / +3.1 % over the Stage-1 engine, 60,591,270 bytes.) `BUILD-INFO.txt` is the build
script's own record (revisions, patch and shim hashes, the SQLite provenance, tool versions, the
regtest twin's and the helper's hashes). The licence files (`LICENSE-MIT`, `LICENSE-APACHE`,
`THIRD-PARTY-NOTICES.md`) are added beside the build output and are not listed in `SHA256SUMS`.

Confirm it with a rebuild:

```sh
EXPECT_MAIN_WASM_SHA256=772d260643a874e261e5067324243b255194b90d2c91d0513e4b6ac0a25e3854 \
  scripts/wallet-engine/build-engine.sh main /some/empty/dir
```

## Licences

- `LICENSE-MIT` and `LICENSE-APACHE`: the licence texts of WebZjs at `bdbc6f2` (the files of that name in
  the WebZjs repository, copied unchanged). WebZjs, librustzcash and orchard are dual-licensed MIT OR
  Apache-2.0; our patches are under the same terms.
- `THIRD-PARTY-NOTICES.md`: every crate compiled into the module, with its version, source and declared
  licence, followed by each distinct licence text shipped by those crates. It is generated, not written
  by hand: `node scripts/wallet-engine/third-party-notices.mjs <patched WebZjs checkout> webzjs-wallet
  wasm32-unknown-unknown > THIRD-PARTY-NOTICES.md`, run on the build's own checkout (same `Cargo.lock`).
  The script reads `cargo metadata` (the dependency graph of the `webzjs-wallet` crate for the wasm target,
  normal dependencies only) and the licence files in each crate's source directory.
- SQLite is in the public domain. The Google Apache-2.0 header in
  `snippets/wasm-bindgen-rayon-*/src/workerHelpers.js` is kept as shipped by wasm-bindgen-rayon.

## Verification before it was vendored

- **Local NU6.3 chain** (zebrad 6.4.2 + lightwalletd v0.5.4, headless Chromium, the game's own
  bridge; `scripts/wallet-engine/harness/run-regtest.mjs`), the regtest twin of this exact build:
  **115/115** (100 page checks + 15 helper checks on every transaction). Shield to Ironwood; a player
  payment with its fee output in ONE v6 transaction; Ironwood → `zs1`; Sapling → Ironwood; an
  Orchard-only `u1`; `t1` and TEX withdrawals; the name fee; refusals with codes; the branch and upgrade
  guards; restore from `db_to_bytes` and from seed + birthday; a real Stage-1 save refused with
  `wallet_format_unsupported` and restored from seed + birthday with its funds and memo; damaged saves
  (page size 0, truncated, corrupt first page) refused with `wallet_format_unsupported`; a half-sent TEX
  pair's error naming the first transaction as sent.
- **The game server's own fee and name checks** with Ironwood and Sapling fee outputs
  (`run-server-checks.mjs`).
- **Legacy Orchard spend** with the native engine on a chain where NU6.3 activates at height 130.
- **Mainnet smoke test without funds** through the game server's bridge to `zec.rocks:443`: 26/26.
- **Public Testnet** (NU7 active): the branch guard refuses sending, balances sync: 12/12.
- Native unit tests: 42 (mainnet build) + 49 (regtest build), including regression tests for the
  TEX, address, shielding and damaged-save rules above.

**Not audited.** A community fork with our patches; ADR-018 § 4 (consent, cap) applies. Known
limits (sync ≈ 2× Stage 1 because of the Ironwood commitment tree, `send` 25–45 s): `API.md` § 13.

## Rebuilding and NU7

`scripts/wallet-engine/build-engine.sh main` rebuilds it from the pinned sources;
`scripts/wallet-engine/README.md` § Moving to NU7 is the upgrade procedure.
