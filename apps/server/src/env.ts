import { readFileSync } from "node:fs";

/**
 * Minimal `.env` loader — no dependency pulled in for this (CORE-002 §5:
 * "keep dependencies minimal"). Only sets a variable if it isn't already
 * present in `process.env`, so real environment variables (e.g. set by
 * a process manager) always win over the file. Missing file is fine —
 * `.env` is a local-dev convenience; `.env.example` documents the shape.
 */
export function loadEnvFile(path = ".env"): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
