import { homedir } from "node:os";
import { engineRun } from "./engine.mjs";
import { preflight } from "./doctor.mjs";
import { envFile } from "./paths.mjs";
import { bad } from "./ui.mjs";

/** Run the gateway in the foreground (Ctrl+C stops it). Refuses to start unless the sandbox prerequisites hold. */
export async function start() {
  const fails = preflight();
  if (fails.length) { for (const f of fails) bad(f); console.error("ferrum: refusing to start"); return 1; }
  console.log("Starting the gateway on 127.0.0.1:18789 (loopback only). In Telegram, write to your bot.");
  console.log(`Panel: http://127.0.0.1:18789/  (token: OPENCLAW_GATEWAY_TOKEN in ${envFile()})`);
  return engineRun(["gateway", "run"], { cwd: homedir() });
}
