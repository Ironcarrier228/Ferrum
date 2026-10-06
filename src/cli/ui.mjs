export const ok = (m) => console.log(`  [ OK ] ${m}`);
export const warn = (m) => console.log(`  [WARN] ${m}`);
export const bad = (m) => console.log(`  [FAIL] ${m}`);
export const hdr = (m) => console.log(`\n== ${m} ==`);
/** Display-only: show the product name and a command the user can actually run in text printed from the underlying CLI. */
export function brand(text) {
  return String(text).replace(/\bopenclaw (?=[a-z])/g, "ferrum engine ").replace(/OpenClaw/g, "Ferrum");
}
export class CliError extends Error {}
export const die = (m) => { throw new CliError(m); };

/** Prompt on the terminal; hidden input for secrets. Never echoes secrets. */
export function ask(prompt, { secret = false } = {}) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return Promise.reject(new CliError("no terminal to ask on"));
  return new Promise((resolve, reject) => {
    stdout.write(`${prompt}: `);
    let buf = "";
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    const done = (fn, v) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData); stdout.write("\n"); fn(v); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\u0003") return done(reject, new CliError("cancelled"));
        if (ch === "\r" || ch === "\n") return done(resolve, buf);
        if (ch === "\u007f" || ch === "\b") { if (buf.length) { buf = buf.slice(0, -1); if (!secret) stdout.write("\b \b"); } continue; }
        if (ch < " ") continue;
        buf += ch; if (!secret) stdout.write(ch);
      }
    };
    stdin.on("data", onData);
  });
}
