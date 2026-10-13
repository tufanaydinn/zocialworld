import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The content seam (content/README.md): code outside `content/production/` never imports it — a tree without the
 * deployment's content module must still compile — and only the composition root resolves the `@zw/content` provider.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The only module that imports `@zw/content`. */
const COMPOSITION_ROOT = "core/App.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|js)$/.test(entry.name) ? [path] : [];
  });
}

function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s;])(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)) {
    specifiers.push((match[1] ?? match[2])!);
  }
  return specifiers;
}

const files = sourceFiles(SRC).map((path) => ({ path, name: relative(SRC, path).split(sep).join("/") }));

test("content seam: nothing outside content/production imports it", () => {
  const offenders: string[] = [];
  for (const { path, name } of files) {
    if (name.startsWith("content/production/")) continue;
    for (const specifier of importSpecifiers(readFileSync(path, "utf8"))) {
      if (specifier.includes("content/production")) offenders.push(`${name} → ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("content seam: only the composition root imports @zw/content", () => {
  const importers = files.filter(({ path }) => importSpecifiers(readFileSync(path, "utf8")).includes("@zw/content")).map(({ name }) => name);
  assert.deepEqual(importers, [COMPOSITION_ROOT]);
});
