import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the installed Ferrum package (or of the repository checkout). */
export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE = join(PKG_ROOT, "config", "ferrum.baseline.json5");
export const SANDBOX_DIR = join(PKG_ROOT, "docker", "sandbox");
export const SANDBOX_IMAGE = "ferrum-sandbox:bookworm-slim"; // must match agents.defaults.sandbox.docker.image in the baseline

// Evaluated lazily: tests (and users) may change HOME.
export const stateDir = () => join(homedir(), ".openclaw");
export const envFile = () => join(stateDir(), ".env");
export const configFile = () => join(stateDir(), "openclaw.json");
export const auditDir = () => join(homedir(), ".ferrum", "audit");
export const workspaceDir = () => join(homedir(), "ferrum", "workspace");
