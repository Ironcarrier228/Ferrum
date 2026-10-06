import { spawn } from "node:child_process";
import { join } from "node:path";
import { PKG_ROOT } from "./paths.mjs";

/** Run one of the bundled WSL helper scripts attached to the terminal. */
export function runScript(name, args = []) {
  return new Promise((resolve) => {
    const child = spawn("bash", [join(PKG_ROOT, "scripts", "wsl", name), ...args], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (e) => { console.error(`ferrum: cannot run ${name}: ${e.message} (these helpers need bash, i.e. Ubuntu/WSL)`); resolve(1); });
  });
}
