#!/usr/bin/env node
// Zocial World — one-time operator tool for the name registry and the transfer fee (ADR-018 § 5/§ 6).
//
// Derives the project's fee/registry account from a seed phrase with the game server's own decryption helper
// (vendor/zcash-tx-decrypt 0.2 — the same librustzcash as the in-game wallet) and prints what the SERVER needs:
// the unified full viewing key (NAME_REGISTRY_UFVK) and the address players pay (NAME_REGISTRY_ADDRESS). With the
// Stage 2 wallet (ADR-018 § 1) that is the FULL unified address — Orchard-family + Sapling +
// transparent receivers — so every client can pay it: a Stage-2 wallet pays its Orchard-family receiver (an Ironwood
// output), a Stage-1 client that has not reloaded yet pays its Sapling receiver; the server counts both. The seed
// itself stays with the operator, offline: the server only ever holds the viewing key.
//
//   node scripts/tools/registry-keys.mjs                      # a FRESH seed: shown once, with a backup warning
//   node scripts/tools/registry-keys.mjs --seed-stdin < seed  # an existing seed from stdin (never printed)
//   options: --network main|test|regtest (default main)  --account N (default 0)
//            --out FILE  also write the server settings (viewing key + addresses, never the seed) to FILE, mode 0600
//
// Run it on an offline machine for the real (mainnet) account. It writes nothing unless --out is given, and never
// logs or writes the seed.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const require = createRequire(import.meta.url);
// fileURLToPath, not URL.pathname: on Windows the pathname is "/C:/…" (require() cannot load it), and a folder name with
// a space would stay "%20"-encoded on every system.
const HELPER = fileURLToPath(new URL("../../vendor/zcash-tx-decrypt/zw_tx_decrypt.js", import.meta.url));

function usage(message) {
  if (message) console.error(`registry-keys: ${message}`);
  console.error("usage: node scripts/tools/registry-keys.mjs [--seed-stdin] [--network main|test|regtest] [--account N] [--out FILE]");
  process.exit(2);
}

function parseArgs(argv) {
  const options = { network: "main", account: 0, seedStdin: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--seed-stdin") options.seedStdin = true;
    else if (arg === "--network") options.network = argv[++i];
    else if (arg === "--account") options.account = Number(argv[++i]);
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (!["main", "test", "regtest"].includes(options.network)) usage("--network must be main, test or regtest");
  if (!Number.isInteger(options.account) || options.account < 0 || options.account > 1000) usage("--account must be a small whole number");
  if (options.out === undefined || options.out === "") usage("--out needs a file name");
  return options;
}

const options = parseArgs(process.argv.slice(2));

let seed;
let fresh = false;
if (options.seedStdin) {
  seed = readFileSync(0, "utf8").trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(seed, wordlist)) {
    console.error("registry-keys: the seed phrase on stdin is not a valid BIP-39 phrase (its words were not printed)");
    process.exit(1);
  }
} else {
  seed = generateMnemonic(wordlist, 256);
  fresh = true;
}

const helper = require(HELPER);
let keys;
try {
  keys = helper.registryKeysFromSeed(seed, options.network, options.account);
} catch (error) {
  console.error(`registry-keys: ${error?.code ?? "error"} — the keys could not be derived`);
  process.exit(1);
}
const info = helper.describeAddress(keys.unifiedAddress);
if (!info.hasSapling || !info.hasOrchard || typeof keys.unifiedShieldedAddress !== "string") {
  console.error("registry-keys: unexpected address shape (the full unified address must have Orchard and Sapling receivers; is vendor/zcash-tx-decrypt 0.2 installed?) — refusing to print it");
  process.exit(1);
}

const settings = [
  `# Zocial World fee/registry account (${options.network}, account ${options.account}) — derived ${new Date().toISOString().slice(0, 10)}`,
  "# The viewing key lets the game server SEE payments to this account (it cannot spend). Keep it private:",
  "# anyone with it sees every name and transfer fee the project received.",
  `NAME_REGISTRY_ADDRESS=${keys.unifiedAddress}`,
  `NAME_REGISTRY_UFVK=${keys.ufvk}`,
  "# The transfer fee uses the same account unless PAYMENT_FEE_ADDRESS / PAYMENT_FEE_UFVK are set.",
  "# NAME_REGISTRY_ADDRESS is the FULL unified address (Orchard + Sapling + transparent receivers): Stage-2 wallets pay",
  "# its Orchard receiver (Ironwood), older clients its Sapling receiver. The server accepts any of the forms below too:",
  `# shielded unified address (Orchard + Sapling, no transparent receiver): ${keys.unifiedShieldedAddress}`,
  `# Sapling-only form of the same receiver (for wallets that cannot pay a unified address): ${keys.saplingAddress}`,
  `# Transparent receiver of the same account (not used by the game, never configure it): ${keys.transparentAddress ?? "-"}`,
];

if (fresh) {
  console.log("=".repeat(78));
  console.log("NEW SEED PHRASE — shown ONCE. Write these 24 words on paper and keep them offline.");
  console.log("They control every fee the project receives. This tool does not store them anywhere.");
  console.log("=".repeat(78));
  const words = seed.split(" ");
  for (let i = 0; i < words.length; i += 6) console.log(words.slice(i, i + 6).map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(10)}`).join(" "));
  console.log("=".repeat(78));
  console.log("");
}
seed = "";

console.log(settings.join("\n"));
console.log(`\n# helper: ${helper.buildInfo()}`);

if (options.out) {
  if (existsSync(options.out)) {
    console.error(`registry-keys: ${options.out} exists — not overwritten`);
    process.exit(1);
  }
  writeFileSync(options.out, `${settings.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(options.out, 0o600);
  console.error(`registry-keys: wrote the server settings (no seed) to ${options.out} (mode 0600)`);
}
