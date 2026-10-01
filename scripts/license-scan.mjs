// Counts the declared license of every package in node_modules (read-only).
// Usage: node scripts/license-scan.mjs
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const counts = new Map();
const names = new Map();
function visit(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === ".bin") continue;
    const p = join(dir, e.name);
    if (e.name.startsWith("@")) { visit(p); continue; }
    const pj = join(p, "package.json");
    if (existsSync(pj)) {
      try {
        const j = JSON.parse(readFileSync(pj, "utf8"));
        let l = j.license ?? (j.licenses ? j.licenses.map((x) => x.type).join(" OR ") : "UNKNOWN");
        if (typeof l === "object") l = l.type ?? "UNKNOWN";
        counts.set(l, (counts.get(l) ?? 0) + 1);
        if (!names.has(l)) names.set(l, []);
        names.get(l).push(j.name);
      } catch {}
    }
    const nm = join(p, "node_modules");
    if (existsSync(nm)) visit(nm);
  }
}
visit("node_modules");
let total = 0;
for (const [l, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  total += n;
  console.log(String(n).padStart(4), l, n <= 5 ? "  <- " + names.get(l).join(", ") : "");
}
console.log("total", total);
