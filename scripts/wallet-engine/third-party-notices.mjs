#!/usr/bin/env node
// Third-party notices for a WebAssembly package built from a Cargo workspace (the wallet engine, the
// decryption helper). Prints Markdown to stdout:
//
//   node third-party-notices.mjs <cargo project dir> <root crate> [target triple] [cargo feature flags] > THIRD-PARTY-NOTICES.md
//
// e.g. the wallet engine (built by WebZjs's `build-wallet` recipe with these features):
//   node third-party-notices.mjs work/WebZjs webzjs-wallet wasm32-unknown-unknown --no-default-features --features wasm,wasm-parallel
//
// The crate set comes from `cargo tree` for the root crate, the target and the given feature flags (normal
// dependencies only: build scripts, proc macros and dev-dependencies are not part of the module); versions,
// sources, declared licences and source directories come from `cargo metadata`. Both run with
// `--locked --offline`, so the build's own Cargo.lock decides every version (the crates must already be
// downloaded, which the build does). Each crate is listed with its version, source and declared licence,
// then every distinct licence text found in those crates' source directories (LICENSE*, LICENCE*,
// COPYING*, COPYRIGHT*, NOTICE*, UNLICENSE*, or the manifest's `license-file`), each followed by the
// crates that ship it. Output is sorted, so the same lock file and flags give the same file.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const [dir, rootName, target = "wasm32-unknown-unknown", ...featureFlags] = process.argv.slice(2);
if (!dir || !rootName) {
  console.error("usage: node third-party-notices.mjs <cargo project dir> <root crate> [target triple] [--no-default-features] [--features a,b]");
  process.exit(2);
}

const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--offline", "--filter-platform", target, ...featureFlags], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }),
);
const byId = new Map(meta.packages.map((p) => [p.id, p]));
const root = meta.packages.find((p) => p.name === rootName && meta.workspace_members.includes(p.id));
if (!root) {
  console.error(`no workspace crate named ${rootName} in ${dir}`);
  process.exit(2);
}

// Normal (runtime) dependencies for the target and features, as cargo resolves them for this crate.
const tree = execFileSync(
  "cargo",
  ["tree", "--locked", "--offline", "-p", rootName, "--target", target, "-e", "normal,no-proc-macro", "--prefix", "none", "--format", "{p}", ...featureFlags],
  { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const wanted = new Set();
for (const line of tree.split("\n")) {
  const m = /^(\S+) v(\S+)/.exec(line.trim());
  if (m) wanted.add(`${m[1]} ${m[2]}`);
}
const seen = new Set(
  meta.packages
    .filter((p) => wanted.has(`${p.name} ${p.version}`))
    // proc-macro crates run in the compiler and are not linked into the module
    .filter((p) => p.id === root.id || !p.targets.some((t) => t.kind.includes("proc-macro")))
    .map((p) => p.id),
);
const sourceOf = (p) => {
  if (!p.source) return "this build (path dependency)";
  if (p.source.startsWith("registry+")) return "crates.io";
  if (p.source.startsWith("git+")) return p.source.slice(4).replace(/\?.*#/, " @ ");
  return p.source;
};
const LICENCE_FILE = /^(licen[sc]e|copying|copyright|notice|unlicense)([-._].*)?$/i;
const filesIn = (base) =>
  readdirSync(base).filter((name) => LICENCE_FILE.test(name) && statSync(path.join(base, name)).isFile());
// Crates from a git checkout or a path often keep their licence files at the repository root: when the
// crate's own directory has none, look in its parent directories (up to the checkout or workspace root).
const licenceFiles = (p) => {
  let base = path.dirname(p.manifest_path);
  let names = new Set(filesIn(base));
  if (p.license_file) names.add(path.relative(base, path.resolve(base, p.license_file)));
  if (names.size === 0 && !p.source?.startsWith("registry+")) {
    const stop = p.source ? null : meta.workspace_root;
    for (let up = path.dirname(base), i = 0; i < 4 && up !== path.dirname(up); up = path.dirname(up), i++) {
      const found = filesIn(up);
      if (found.length) {
        base = up;
        names = new Set(found);
        break;
      }
      if (up === stop || readdirSync(up).includes(".git")) break;
    }
  }
  const rel = path.relative(path.dirname(p.manifest_path), base);
  return [...names].sort().map((name) => ({
    name: rel ? `${rel}/${name}` : name,
    text: readFileSync(path.join(base, name), "utf8").replace(/\r\n/g, "\n").trim(),
  }));
};

const crates = [...seen]
  .filter((id) => id !== root.id)
  .map((id) => byId.get(id))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const texts = new Map(); // whitespace-normalised text -> { text, files: Set, crates: Set }
const rows = [];
for (const p of crates) {
  const files = licenceFiles(p);
  for (const f of files) {
    // Texts that differ only in whitespace are one text (the first one seen is printed).
    const key = f.text.replace(/\s+/g, " ");
    const entry = texts.get(key) ?? { text: f.text, files: new Set(), crates: new Set() };
    entry.files.add(path.basename(f.name));
    entry.crates.add(`${p.name} ${p.version}`);
    texts.set(key, entry);
  }
  rows.push(`| ${p.name} | ${p.version} | ${(p.license ?? (p.license_file ? "see licence file" : "not declared")).replace(/\|/g, "\\|")} | ${sourceOf(p)} | ${files.map((f) => f.name).join(", ") || "none shipped"} |`);
}

const out = [];
out.push(`# Third-party notices: ${root.name} ${root.version}`);
out.push("");
out.push(`The crates compiled into the ${target} module built from \`${root.name}\`${featureFlags.length ? ` (${featureFlags.join(" ")})` : ""}, from its Cargo.lock, and the`);
out.push("licence texts they ship. Generated by `scripts/wallet-engine/third-party-notices.mjs`; do not edit by hand.");
out.push("The Rust standard library (core, alloc, std; MIT OR Apache-2.0) is compiled in as well.");
out.push("");
out.push(`${crates.length} crates.`);
out.push("");
out.push("| Crate | Version | Licence | Source | Licence files |");
out.push("|---|---|---|---|---|");
out.push(...rows);
out.push("");
out.push("## Licence texts");
out.push("");
const sortedTexts = [...texts.entries()].sort((a, b) => {
  const ka = [...a[1].crates].sort()[0];
  const kb = [...b[1].crates].sort()[0];
  return ka.localeCompare(kb);
});
sortedTexts.forEach(([, entry], i) => {
  const users = [...entry.crates].sort();
  out.push(`### Text ${i + 1} (${[...entry.files].sort().join(", ")})`);
  out.push("");
  out.push(`Shipped by: ${users.join(", ")}.`);
  out.push("");
  out.push("```text");
  // Relative Markdown links in a crate's licence file point into that crate, not into this directory:
  // they are printed as plain text, "name (target)".
  out.push(entry.text.replace(/\[([^\]]*)\]\((?![a-z][a-z0-9+.-]*:)([^)]*)\)/gi, "$1 ($2)").replace(/```/g, "'''"));
  out.push("```");
  out.push("");
});
process.stdout.write(out.join("\n"));
