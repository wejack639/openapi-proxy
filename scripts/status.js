import { isRunning, logFile, readPid } from "./process-utils.js";

const host = process.env.PROXY_HOST || "127.0.0.1";
const port = Number(process.env.PROXY_PORT || 11434);
const pid = await readPid();

if (isRunning(pid)) {
  console.log(`openapi-proxy running pid=${pid}`);
  console.log(`UI: http://${host}:${port}/`);
  console.log(`Log file: ${logFile}`);
  process.exit(0);
}

console.log("openapi-proxy is not running");
process.exit(1);
