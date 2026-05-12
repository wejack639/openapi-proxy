import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const stateDir = path.resolve(process.cwd(), ".state");
export const pidFile = path.join(stateDir, "proxy.pid");
export const logFile = path.join(stateDir, "proxy.log");

export async function ensureStateDir() {
  await fsp.mkdir(stateDir, { recursive: true });
}

export async function readPid() {
  try {
    const text = await fsp.readFile(pidFile, "utf8");
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isRunning(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function writePid(pid) {
  await ensureStateDir();
  await fsp.writeFile(pidFile, `${pid}\n`);
}

export async function removePid() {
  await fsp.rm(pidFile, { force: true });
}

export function openLogFd() {
  fs.mkdirSync(stateDir, { recursive: true });
  return fs.openSync(logFile, "a");
}

export async function waitForHealth(url, timeoutMs = 5000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error("Health check timed out");
}
