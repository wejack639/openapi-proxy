import fs from "node:fs/promises";
import path from "node:path";

export class ResponseStore {
  constructor({ filePath, ttlSeconds = 86400 } = {}) {
    this.filePath = filePath;
    this.ttlSeconds = ttlSeconds;
    this.memory = new Map();
  }

  async get(responseId) {
    await this.load();
    const entry = this.memory.get(responseId);
    if (!entry) {
      return null;
    }
    if (entry.expires_at && entry.expires_at < Date.now()) {
      this.memory.delete(responseId);
      await this.flush();
      return null;
    }
    return entry;
  }

  async findByPendingToolCallIds(callIds = []) {
    const matches = await this.findAllByPendingToolCallIds(callIds);
    return matches[0] || null;
  }

  async findAllByPendingToolCallIds(callIds = []) {
    await this.load();
    const ids = new Set(callIds.filter(Boolean));
    if (ids.size === 0) {
      return [];
    }

    const matches = [];
    for (const entry of this.memory.values()) {
      const pending = Array.isArray(entry.pending_tool_calls) ? entry.pending_tool_calls : [];
      const score = pending.filter((call) => ids.has(call.call_id)).length;
      if (score > 0) {
        matches.push({ entry, score, createdAt: entry.created_at || 0 });
      }
    }
    return matches
      .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
      .map((match) => match.entry);
  }

  async save(responseId, entry) {
    await this.load();
    this.memory.set(responseId, {
      ...entry,
      id: responseId,
      created_at: entry.created_at || Math.floor(Date.now() / 1000),
      expires_at: Date.now() + this.ttlSeconds * 1000
    });
    await this.flush();
  }

  async clear() {
    await this.load();
    this.memory.clear();
    await this.flush();
  }

  async load() {
    if (!this.filePath || this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      const records = JSON.parse(text);
      if (!records || typeof records !== "object") {
        return;
      }
      for (const [id, entry] of Object.entries(records)) {
        this.memory.set(id, entry);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async flush() {
    if (!this.filePath) {
      return;
    }
    const records = Object.fromEntries(this.memory.entries());
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(records, null, 2));
  }
}
