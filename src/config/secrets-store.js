import fs from "node:fs/promises";
import path from "node:path";

export class SecretsStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async readAll() {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(text);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  async get(ref) {
    if (!ref) {
      return "";
    }
    const secrets = await this.readAll();
    return secrets[ref] || "";
  }

  async set(ref, value) {
    if (!ref || !value) {
      return;
    }
    const secrets = await this.readAll();
    secrets[ref] = value;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.filePath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    await fs.chmod(this.filePath, 0o600).catch(() => {});
  }
}

export function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
