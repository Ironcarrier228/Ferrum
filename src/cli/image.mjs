import { spawnSync } from "node:child_process";
import { SANDBOX_DIR, SANDBOX_IMAGE } from "./paths.mjs";
import { hdr, ok, die } from "./ui.mjs";

/** Build the sandbox image (network is needed for apt during the BUILD only; running containers have none). */
export function sandboxImage() {
  const run = (args, opts = {}) => spawnSync("docker", args, { stdio: "inherit", ...opts });
  const v = spawnSync("docker", ["version"], { encoding: "utf8" });
  if (v.error) die("docker not found; run scripts/wsl/20-install-docker.sh");
  if (spawnSync("docker", ["info"], { encoding: "utf8" }).status !== 0) die("docker daemon not reachable without sudo (re-open the terminal after installing docker)");
  if (run(["build", "--pull", "-t", SANDBOX_IMAGE, "-f", `${SANDBOX_DIR}/Dockerfile`, SANDBOX_DIR]).status !== 0) die("docker build failed");
  hdr("Smoke test (network none, read-only root, no caps)");
  const r = run(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", SANDBOX_IMAGE,
    "bash", "-c", 'echo "user=$(id -un) uid=$(id -u)"; python3 --version; rg --version | head -1; curl --version | head -1']);
  if (r.status !== 0) die("smoke test failed");
  ok("image works");
  return 0;
}
