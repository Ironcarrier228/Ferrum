// Windows path canonicalisation for the local_* tools.
// Input may be `D:\Ferrum\x`, `D:/Ferrum/x`, `/mnt/d/Ferrum/x` or relative to the root.
// Everything outside `root`, and every ambiguous form, is rejected (never "fixed up").

export type PathResult =
  | { ok: true; win: string; rel: string; parts: string[] }
  | { ok: false; reason: string };

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
const FORBIDDEN_CHARS = /[<>"|?*\u0000-\u001f]/;
const PROTECTED_SEGMENTS = new Set(["$recycle.bin", "system volume information", "$winreagent"]);

const fold = (s: string) => s.normalize("NFC").toLowerCase();

export function normalizeRoot(root: string): { drive: string; parts: string[]; win: string } {
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(root);
  if (!m) throw new Error(`localRoot must be an absolute Windows path with a drive letter: ${root}`);
  const parts = m[2].split(/[\\/]+/).filter(Boolean);
  const drive = m[1].toUpperCase();
  return { drive, parts, win: `${drive}:\\${parts.join("\\")}` };
}

export function resolveInRoot(input: unknown, root: string): PathResult {
  if (typeof input !== "string" || input.length === 0) return { ok: false, reason: "path must be a non-empty string" };
  if (input.length > 1000) return { ok: false, reason: "path is too long" };
  if (/[\u0000-\u001f]/.test(input)) return { ok: false, reason: "control characters in path" };
  const r = normalizeRoot(root);

  let p = input;
  // WSL form: /mnt/d/...
  const wsl = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(p);
  if (wsl) p = `${wsl[1].toUpperCase()}:\\${(wsl[2] ?? "").replace(/\//g, "\\")}`;
  else if (/^[\\/]{2}/.test(p)) return { ok: false, reason: "UNC / device paths are not allowed" };
  else if (p.startsWith("/")) return { ok: false, reason: "POSIX path outside /mnt/<drive> is not allowed" };

  p = p.replace(/\//g, "\\");
  if (p.startsWith("\\\\")) return { ok: false, reason: "UNC / device paths are not allowed" };
  if (p.startsWith("\\")) return { ok: false, reason: "paths without a drive letter must be relative, not rooted" };

  let drive = r.drive;
  let segs: string[];
  const d = /^([A-Za-z]):(.*)$/.exec(p);
  if (d) {
    if (!d[2].startsWith("\\")) return { ok: false, reason: "drive-relative path (X:foo) is not allowed" };
    drive = d[1].toUpperCase();
    segs = d[2].split("\\");
  } else {
    segs = [...r.parts, ...p.split("\\")];
  }

  const out: string[] = [];
  for (const raw of segs) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") { if (out.length === 0) return { ok: false, reason: "path escapes the drive root" }; out.pop(); continue; }
    if (raw.includes(":")) return { ok: false, reason: "':' in a path segment (alternate data stream?) is not allowed" };
    if (FORBIDDEN_CHARS.test(raw)) return { ok: false, reason: "forbidden characters in path" };
    if (/[ .]$/.test(raw)) return { ok: false, reason: "segment ends with a space or dot (Windows strips it)" };
    if (/~\d/.test(raw)) return { ok: false, reason: "8.3 short names (NAME~1) are not allowed" };
    if (RESERVED.test(raw)) return { ok: false, reason: "reserved Windows device name" };
    out.push(raw);
  }

  if (drive !== r.drive) return { ok: false, reason: `outside the allowed drive ${r.drive}:` };
  const inside = r.parts.length <= out.length && r.parts.every((s, i) => fold(s) === fold(out[i]));
  if (!inside) return { ok: false, reason: `outside the allowed folder ${r.win}` };
  const rel = out.slice(r.parts.length);
  for (const s of rel) {
    if (PROTECTED_SEGMENTS.has(fold(s))) return { ok: false, reason: "protected system folder" };
  }
  const last = rel.at(-1);
  if (last && /\.(vhdx?|vmdk)$/i.test(last)) return { ok: false, reason: "virtual disk images are never accessible (WSL disk!)" };
  return { ok: true, win: `${r.drive}:\\${out.join("\\")}`, rel: rel.join("\\"), parts: rel };
}

/** `D:\Ferrum\a\b` -> `<mount>/a/b` for the gateway's own fs access. */
export function toHostPath(rel: string, mount: string): string {
  const m = mount.replace(/\/+$/, "");
  return rel ? `${m}/${rel.replace(/\\/g, "/")}` : m;
}
