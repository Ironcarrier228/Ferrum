import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT } from "./paths.mjs";
import { engineBin, engineRun } from "./engine.mjs";
import { CliError } from "./ui.mjs";

const HELP = `ferrum: a personal AI agent with an isolated sandbox and an opt-in local mode

Usage: ferrum <command>

  preflight                   check this computer (read-only)
  install-docker              install Docker inside Ubuntu (asks for confirmation, needs sudo)
  setup [--reset] [--no-key]  store secrets (hidden prompts) and install the config
  doctor                      read-only health check; exit 1 if something is wrong
  start                       run the gateway in the foreground (loopback only)
  sandbox-image               build the Docker image used by the sandbox
  engine <args...>            run the underlying engine CLI with the same state directory
  version                     print versions
  help                        this text

Docs: docs/DEVELOPERS.md
`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined: case "help": case "--help": case "-h": process.stdout.write(HELP); return 0;
      case "version": case "--version": case "-v": {
        const me = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
        console.log(`ferrum ${me.version}\nengine ${engineBin().version}\nnode ${process.versions.node}`);
        return 0;
      }
      case "preflight": return await (await import("./scripts.mjs")).runScript("00-preflight.sh");
      case "install-docker": return await (await import("./scripts.mjs")).runScript("20-install-docker.sh", rest);
      case "setup": return await (await import("./setup.mjs")).setup(rest);
      case "doctor": return await (await import("./doctor.mjs")).doctor();
      case "start": return await (await import("./start.mjs")).start();
      case "sandbox-image": return (await import("./image.mjs")).sandboxImage();
      case "engine": return await engineRun(rest);
      default: console.error(`ferrum: unknown command '${cmd}'\n\n${HELP}`); return 2;
    }
  } catch (e) {
    if (e instanceof CliError) { console.error(`ferrum: ${e.message}`); return 1; }
    throw e;
  }
}
