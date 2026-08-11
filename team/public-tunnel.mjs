import { spawn } from "node:child_process";
import process from "node:process";

const port = Number(process.env.STUDIO_TEAM_PORT || 4180);
const nodeArgs = ["--env-file-if-exists=team/.env", "team/central-server.mjs"];
const central = spawn(process.execPath, nodeArgs, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const tunnel = spawn(npx, ["--yes", "localtunnel", "--port", String(port), "--local-host", "127.0.0.1"], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });

central.stdout.on("data", data => process.stdout.write(`[central] ${data}`));
central.stderr.on("data", data => process.stderr.write(`[central] ${data}`));
tunnel.stdout.on("data", data => process.stdout.write(data));
tunnel.stderr.on("data", data => process.stderr.write(`[tunnel] ${data}`));

function shutdown() { if (!central.killed) central.kill(); if (!tunnel.killed) tunnel.kill(); }
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
central.on("exit", code => { if (code && !tunnel.killed) tunnel.kill(); });
