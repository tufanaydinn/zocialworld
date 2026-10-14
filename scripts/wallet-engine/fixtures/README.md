# Fixtures (REGTEST ONLY — test keys, never fund on any network)

Keys and transactions of local zebrad 6.4.2 regtest chains (every upgrade through NU6.3 at height 1).
The seeds below are public test keys for the local regtest chain. Never use them anywhere else and never
send funds to any address derived from them, on any network: anyone can spend what arrives there.

* `regtest-stage2-txs.json` — every transaction the Stage-2 engine (regtest twin of the reproducible
  build, `be113e2d…`) produced in a full run of `../harness/run-regtest.mjs`, fetched from zebrad:
  `shield` (3 coinbase UTXOs → Ironwood), `ironwoodPayment` (B → A 100,000 + fee output 75,000 to
  PROJECT's shielded UA, one tx), `paymentSaplingFee` (fee output to PROJECT's Stage-1 UA → Sapling),
  `ironwoodToSapling`, `saplingToIronwood`, `orchardOnlyUa` (→ PROJECT's Orchard-only UA),
  `withdrawalT`, `texStep1` / `texStep2` (TEX withdrawal), `nameFee` (Ironwood, `zw-name:v1:…`),
  `legacyPayment`, `toStage1Player` (B → the Stage-1 player D: Sapling + transparent outputs in one
  tx), `restoredShield` / `restoredPayment` (D's wallet restored from seed + birthday after its
  Stage-1 save was refused: shield, then pay from the Stage-1 Sapling note), `smallShield`,
  `lostAnswer`. Each entry: `rawTxHex`, `height`, `txid`, the helper's `shape`, and what each key
  (A, B, C, PROJECT, D = seed C account 3) decrypts with zw-tx-decrypt 0.2; `addresses` are the
  engine's five encodings per wallet; `feeNonce`, `nameMemo`, `restoredMemo` the run's memos.
* `regtest-ironwood-txs.json` — an earlier run's transactions (same engine bytes) with the expected
  values the helper's Node tests assert (= `../zw-tx-decrypt/test/fixtures/regtest-ironwood-txs.json`
  and `vendor/zcash-tx-decrypt/test/fixtures/regtest-ironwood-txs.json`).
* `regtest-seeds.json` — the regtest test seeds of A, B, C and PROJECT (unchanged since Stage 1;
  the engine's own cargo tests use the same file, added by patch 0004).
* `test-addresses.json` — Orchard-only, Orchard + Sapling, Orchard + transparent UAs and a TEX
  address per network, from seed C (unchanged since Stage 1); used for the recipient-rule refusals.
* `project-regtest-addresses.json` — the same four addresses for PROJECT on regtest (the run pays
  PROJECT's Orchard-only UA), made with `zw-tx-decrypt/examples/test_addresses.rs`.

The Stage-1 fixture (`regtest-txs.json`, v5 Sapling-beta transactions) is kept in
`vendor/zcash-tx-decrypt/test/fixtures/regtest-txs.json` and `../zw-tx-decrypt/test/fixtures/`: the helper's
tests and the game server's tests still decrypt it (a Stage-1 client that has not reloaded yet pays Sapling).
