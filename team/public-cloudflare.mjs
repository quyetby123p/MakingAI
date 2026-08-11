import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const port = Number(process.env.STUDIO_TEAM_PORT || 4180);
const stateFile = path.resolve(process.env.STUDIO_PUBLIC_URL_FILE || "team-data/public-url.txt");
const logFile = `${stateFile}.cloudflared.log`;
const logFd = openSync(logFile, "a");
const central = spawn(process.execPath, ["--env-file-if-exists=team/.env", "team/central-server.mjs"], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "ignore"], detached: true });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const tunnel = spawn(npx, ["--yes", "cloudflared", "tunnel", "--url", `http://127.0.0.1:${port}`], { cwd: process.cwd(), env: process.env, stdio: ["ignore", logFd, logFd], windowsHide: true, shell: process.platform === "win32", detached: true });

central.stdout?.on("data", data => process.stdout.write(`[central] ${data}`));
central.stderr?.on("data", data => process.stderr.write(`[central] ${data}`));
function shutdown() { if (!central.killed) central.kill(); if (!tunnel.killed) tunnel.kill(); }
process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
