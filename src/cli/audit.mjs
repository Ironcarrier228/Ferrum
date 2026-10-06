// `ferrum audit [N] [--json]`: the last N records of the audit log (~/.ferrum/audit), newest last.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditDir } from "./paths.mjs";
import { CliError } from "./ui.mjs";

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** One readable line for one audit record. */
export function formatRecord(r) {
  const time = typeof r.ts === "string" ? r.ts.replace("T", " ").slice(0, 19) : "?";
  const what = [r.ev, r.tool ?? r.mode ?? r.command, r.decision].filter(Boolean).join(" ");
  const why = r.reason ?? r.title ?? "";
  const p = r.params && typeof r.params === "object" ? Object.values(r.params).map(String).join(" ") : "";
  return clip(`${time}  ${what}${why ? `  (${why})` : ""}${p ? `  ${p}` : ""}`, 200);
}

export function readRecords(dir, count) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const out = [];
  for (let i = files.length - 1; i >= 0 && out.length < count; i--) {
    const recs = [];
    for (const line of readFileSync(join(dir, files[i]), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { recs.push(JSON.parse(line)); } catch { recs.push({ ev: "unreadable line" }); }
    }
    out.unshift(...recs.slice(-(count - out.length)));
  }
  return out.slice(-count);
}

export function audit(args) {
  const json = args.includes("--json");
  const nums = args.filter((a) => !a.startsWith("--"));
  if (nums.length > 1 || args.some((a) => a.startsWith("--") && a !== "--json")) throw new CliError("использование: ferrum audit [число записей] [--json]");
  const n = nums.length ? Number(nums[0]) : 20;
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw new CliError("число записей должно быть от 1 до 10000");
  const recs = readRecords(auditDir(), n);
  if (!recs.length) { console.log(`Журнал пуст (${auditDir()}). Записи появятся, когда агент начнёт работать.`); return 0; }
  for (const r of recs) console.log(json ? JSON.stringify(r) : formatRecord(r));
  return 0;
}
