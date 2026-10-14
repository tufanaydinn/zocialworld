# apps/web/src/zcash — the in-game wallet

The player's own Zcash wallet, in the browser: create, restore, unlock, sync, receive, pay players
privately (ADR-013), confirm a name (ADR-016), and — on a mainnet build — the experimental mainnet
beta wallet of ADR-018 (the Stage 2 "Ironwood" engine). The seed is generated and kept encrypted in
this browser; the game server never sees it, and no other player ever sees an address, balance or
history.

## Two builds, one adapter

`VITE_ZCASH_NETWORK` decides everything at build time (fail closed: anything but `test` or `main`
refuses to build or start):

| | `test` (default) | `main` (ADR-018) |
|---|---|---|
| Engine | the test-network WebZjs build ("test" = the project's own regtest chain) when its binary is installed; otherwise the stand-in engine `core/engineStub.js` | the mainnet engine (based on the Zcash Community Grants WebZjs fork, upstream `zcash_client_sqlite` in wasm, NU6.3); the build fails closed without it |
| Chain | the project's own regtest chain | Zcash mainnet, through this game server's bridge (`LIGHTWALLETD_URL`, `zec.rocks` by default) |
| Addresses | one unified address (Orchard + Sapling + transparent) | the **full unified address** (Orchard-family + Sapling + transparent receivers) for "Add funds", its Sapling form (`zs1…`), the transparent "exchange address" (`t1…`), and a **shielded-only** unified address (no transparent receiver) that is the only one sealed to a payer |
| Spends | Orchard/Sapling | every shielded pool (Ironwood, Sapling, legacy Orchard); outputs to Orchard-family receivers and change are **Ironwood**, version-6 transactions; transparent funds must be shielded first (into Ironwood); withdrawals to `u1…`, `zs1…`, `t1…` and TEX (`tex1…`, two transactions) |
| Coins | the in-game faucet | none: "Add funds" from an exchange or another wallet |
| Limits | — | consent step, backup check, 0.01 ZEC per transaction by default (`VITE_MAINNET_TX_CAP_ZEC`), sending paused on a consensus-branch mismatch |
| Storage keys | `zw.wallet.seed.v1`, `zw-wallet-regtest` | `zw.wallet.seed.main.v1`, `zw-wallet-main` (a test wallet is never opened as a mainnet wallet), the wallet's birthday `zw.wallet.birthday.main.v1` (for a rescan) |
| Upgrade | — | a wallet saved by the Stage 1 engine (`wallet_format_unsupported`) is **rescanned once** from its encrypted seed and birthday at unlock (`stage1Save.ts` reads the birthday from the old save); a progress line shows how far, and sending waits until it ends |

`vite.config.ts` copies (and in development aliases) the engine of the build's network.

The stand-in engine lets a checkout without the engine binary typecheck, build and run everything
except the wallet: every call fails with `engine_not_installed`, and the wallet panel says the engine
is not installed in this build. The engine's sources and build are in `scripts/wallet-engine/`.

## Files

| File | What |
|---|---|
| `core/wallet.ts` | The WebZjs boundary (`ZecWallet`), loaded lazily (≈ 60 MB wasm). On main it adds `mainnetEngine`: `addresses` (five forms), `sendingStatus`, `previewSend`/`send` (ONE transaction for several outputs; TEX = two), `previewShield`/`shield`; `balances` reports each shielded pool. Test seam: `__testSeam.walletFactory`. |
| `core/engineStub.js` | The stand-in engine of a test build without the engine binary (every call fails with `engine_not_installed`). |
| `core/store.ts`, `core/keystore.ts`, `core/keys.ts` | Encrypted seed (PBKDF2 + AES-GCM), the wallet database in IndexedDB, BIP-39 and the viewing key (`@chainsafe/webzjs-keys`). Per-network storage keys and the mainnet "backup pending" flag. |
| `core/wallet-types.ts` | Address and key format checks, the active network (`ZCASH_NETWORK`), ZIP-321 URIs. |
| `ZcashWalletAdapter.ts` | The adapter every UI uses. **Enforces the mainnet cap** (`txCap.ts`) on payments (the recipient amount; the project fee comes on top), withdrawals and the name fee — shielding is exempt — and refuses to send or give an address while a new mainnet wallet's backup is unconfirmed or a Stage 1 wallet is being rescanned (`wallet_migrating`). `SendRequest` → `previewSend` / `sendRequest` / `sendRequestTxids`, `previewShield` / `shieldTransparent`, `getAddresses`, `sendingStatus`, `confirmBackup`; `getWalletState().migration` for the rescan. |
| `WalletPanel.ts` | The wallet UI (also onboarding's wallet step). Main: consent, create → 24 words → backup check, restore with "When did you create this wallet?" (every shielded pool of a Zashi/Zodl/Zingo seed is found), balance ("Shielded" = Ironwood + Sapling + legacy Orchard / "Waiting to be shielded" + Shield into Ironwood), "Add funds" (full `u1…`, `t1…`, `zs1…`), "Withdraw" (`u1…`/`zs1…`/`t1…`/TEX, public-amount warning — also for a Sapling destination paid from Ironwood; the own-address guard knows the TEX form of the own `t1…`), the Stage 1 rescan card (the date picked survives a wrong passphrase), sending paused. No faucet. |
| `PaymentFlow.ts` | "Send ZEC" (ADR-013). Main: the request declares the cap (`capZat`); a fee quote from the server is checked; the confirmation card shows **recipient gets X / project fee ≈ US$1 / network fee**; ONE engine call; `pay_sent` for the server's fee check before the sealed notice. |
| `SupportFlow.ts` | Project support payments (ZIP-321 request with a memo). |
| `paymentCrypto.ts` | ECDH P-256 → HKDF → AES-GCM sealing and the 4-emoji security code. |
| `txCap.ts` | The cap (ADR-018 § 4): `capForNetwork`, `capProblem`, exact ZEC amounts. |
| `engineErrors.ts` | Plain sentences for the engine's coded errors (`recipient_unsupported`, `pool_policy_violation`, `consensus_branch_mismatch`, `wallet_format_unsupported`, …). Never shows the engine's raw text. |
| `stage1Save.ts` | Reads a Stage 1 (protobuf) save's account birthday for the one-time rescan; no keys are read. |
| `texAddress.ts` | ZIP 320 TEX address check (bech32m, network HRP, 20-byte hash); the TEX form of a `t1…`/`tm…` address. |
| `poolCrossing.ts` | When a Sapling output funded from Ironwood makes the amount public: the withdraw Review and the payment confirmation warn. |
| `migrationProgress.ts` | The rescan's progress estimate and elapsed-time text. |
| `birthday.ts` | Month/year → birthday height (anchor table, 75 s blocks, 25 s after NU7 — set `NU7_ACTIVATION_HEIGHT` there when it is announced). |
| `mainnetConsent.ts` | The consent step's wording and its per-device memory (`zw-mainnet-consent-v1`, try/catch storage). |
| `backupQuiz.ts` | The backup check (3 positions, 4 choices from the phrase). |
| `config.ts` | Network config (fail closed) and the bridge URL. |
| `testChain.ts`, `faucetClient.ts` | Test-chain faucet copy and client (never on mainnet). |
| `nameKey.ts` | The name key (ADR-016), derived from the seed at unlock. |
| `participation.ts` | The one wallet-derived bit that leaves the browser: "is a wallet holder" (ADR-015). |

## Rules this module keeps

- The seed phrase is shown only at creation and on a passphrase-protected backup request; it is
  never logged or sent.
- Addresses are shown only to the owner, in the owner's panel ("Add funds", or the test chain's
  "Show my receive address"). Another player only ever receives one sealed to their wallet
  (ADR-013). On mainnet, sync asks lightwalletd (through the game server's bridge) about the
  wallet's transparent receiver to find deposits, so the bridge and lightwalletd see that address.
- Everything renders with `textContent`.
- Mainnet sends always show their network fee; a player payment also shows the project fee.
- Engine errors are mapped to sentences; nothing from the engine's error text (which can carry an
  address) reaches the screen, the server or a log.

Threat models: `docs/privacy/ZCASH_WALLET_THREAT_MODEL.md`, `PLAYER_PAYMENTS_THREAT_MODEL.md`
(§ Mainnet), `IDENTITY_THREAT_MODEL.md` (§ 12). Decisions: ADR-013, ADR-015, ADR-016, ADR-018.
