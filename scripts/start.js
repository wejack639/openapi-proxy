import { spawn } from "node:child_process";
import { openLogFd, pidFile, readPid, isRunning, writePid, waitForHealth, logFile } from "./process-utils.js";

const host = process.env.PROXY_HOST || "127.0.0.1";
const port = Number(process.env.PROXY_PORT || 11434);
const healthUrl = `http://${host}:${port}/health`;

const existingPid = await readPid();
if (isRunning(existingPid)) {
  console.log(`openapi-proxy already running pid=${existingPid}`);
  console.log(`UI: http://${host}:${port}/`);
  process.exit(0);
}

const logFd = openLogFd();
const child = spawn(process.execPath, ["src/index.js"], {
  cwd: process.cwd(),
  detached: true,
  stdio: ["ignore", logFd, logFd],
  env: process.env
});
child.unref();
await writePid(child.pid);

try {
  await waitForHealth(healthUrl);
  console.log(`openapi-proxy started pid=${child.pid}`);
  console.log(`UI: http://${host}:${port}/`);
  console.log(`PID file: ${pidFile}`);
  console.log(`Log file: ${logFile}`);
} catch (error) {
  console.error(`openapi-proxy failed to start: ${error.message}`);
  console.error(`Log file: ${logFile}`);
  process.exit(1);
}
