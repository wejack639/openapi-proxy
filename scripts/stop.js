import { isRunning, readPid, removePid } from "./process-utils.js";

const pid = await readPid();
if (!pid || !isRunning(pid)) {
  await removePid();
  console.log("openapi-proxy is not running");
  process.exit(0);
}

process.kill(pid, "SIGTERM");
for (let index = 0; index < 20; index += 1) {
  if (!isRunning(pid)) {
    await removePid();
    console.log(`openapi-proxy stopped pid=${pid}`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}

console.error(`openapi-proxy did not stop after SIGTERM pid=${pid}`);
process.exit(1);
