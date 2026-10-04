import { readFileSync, existsSync } from "node:fs";

/** Parse KEY=VALUE lines (never sourced, so no shell/JS injection). Last value wins. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
export const readEnv = (file) => (existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {});
