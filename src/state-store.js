import { randomUUID } from "node:crypto";

import { fetchWithTimeout, sleep, truncate } from "./shared.js";

const READY = "ready";
const INITIALIZATION_LOCK_SECONDS = 300;
const DELIVERY_LOCK_SECONDS = 300;
const BATCH_SIZE = 250;

const CLAIM_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return 'sent'
end
if redis.call('SET', KEYS[2], ARGV[2], 'NX', 'EX', ARGV[3]) then
  return 'acquired'
end
return 'pending'
`;

const COMPLETE_SCRIPT = `
if redis.call('GET', KEYS[2]) == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  redis.call('DEL', KEYS[2])
  return 1
end
return 0
`;

function legacyUpdateKeys(rawState) {
  if (rawState === null) return [];
  try {
    const parsed = typeof rawState === "string" ? JSON.parse(rawState) : rawState;
    if (!parsed?.seenUpdates || typeof parsed.seenUpdates !== "object") return [];
    return Object.keys(parsed.seenUpdates);
  } catch {
    return [];
  }
}

export class UpstashStateStore {
  constructor({ url, token, key, timeoutMs, keepaliveMs }) {
    this.backend = "upstash";
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.key = key;
    this.readyKey = `${key}:initialized`;
    this.seenKey = `${key}:updates`;
    this.timeoutMs = timeoutMs;
    this.keepaliveMs = keepaliveMs;
    this.ready = false;
    this.seenUpdates = new Set();
    this.lastAccessAt = 0;
    this.lastKeepaliveAttemptAt = 0;
  }

  get stateEntries() {
    return this.seenUpdates.size;
  }

  has(updateKey) {
    return this.seenUpdates.has(updateKey);
  }

  async command(...parts) {
    const response = await fetchWithTimeout(
      this.url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": "discord-status-webhook/1.0",
        },
        body: JSON.stringify(parts),
      },
      this.timeoutMs,
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      throw new Error(
        `Upstash ตอบกลับ HTTP ${response.status}${body.error ? `: ${truncate(body.error, 200)}` : ""}`,
      );
    }
    this.lastAccessAt = Date.now();
    return body.result;
  }

  async load() {
    try {
      const [status, updateKeys] = await Promise.all([
        this.command("GET", this.readyKey),
        this.command("HKEYS", this.seenKey),
      ]);
      this.ready = status === READY;
      this.seenUpdates = new Set(updateKeys || []);
    } catch (error) {
      throw new Error(`อ่าน state จาก Upstash ไม่สำเร็จ: ${error.message}`);
    }
  }

  async markSeen(updateKeys) {
    const uniqueKeys = [...new Set(updateKeys)].filter(
      (updateKey) => !this.seenUpdates.has(updateKey),
    );
    const timestamp = new Date().toISOString();

    for (let index = 0; index < uniqueKeys.length; index += BATCH_SIZE) {
      const batch = uniqueKeys.slice(index, index + BATCH_SIZE);
      const fields = batch.flatMap((updateKey) => [updateKey, timestamp]);
      await this.command("HSET", this.seenKey, ...fields);
      for (const updateKey of batch) this.seenUpdates.add(updateKey);
    }
  }

  async initialize(baselineKeys) {
    if (this.ready) return true;

    const token = `initializing:${randomUUID()}`;
    const acquired = await this.command(
      "SET",
      this.readyKey,
      token,
      "NX",
      "EX",
      INITIALIZATION_LOCK_SECONDS,
    );
    if (acquired !== "OK") {
      const status = await this.command("GET", this.readyKey);
      if (status !== READY) return false;
      this.ready = true;
      const updateKeys = await this.command("HKEYS", this.seenKey);
      this.seenUpdates = new Set(updateKeys || []);
      return true;
    }

    try {
      const oldState = await this.command("GET", this.key);
      await this.markSeen([...legacyUpdateKeys(oldState), ...baselineKeys]);
      await this.command("SET", this.readyKey, READY);
      this.ready = true;
      return true;
    } catch (error) {
      await this.releaseLock(this.readyKey, token).catch(() => {});
      throw error;
    }
  }

  lockKey(updateKey) {
    return `${this.key}:lock:${updateKey}`;
  }

  async claim(updateKey) {
    if (this.has(updateKey)) return { status: "sent" };

    const token = `pending:${randomUUID()}`;
    const lockKey = this.lockKey(updateKey);
    const status = await this.command(
      "EVAL",
      CLAIM_SCRIPT,
      2,
      this.seenKey,
      lockKey,
      updateKey,
      token,
      DELIVERY_LOCK_SECONDS,
    );
    if (status === "sent") {
      this.seenUpdates.add(updateKey);
      return { status: "sent" };
    }
    return status === "acquired"
      ? { status: "acquired", token }
      : { status: "pending" };
  }

  async complete(updateKey, token) {
    const timestamp = new Date().toISOString();
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const completed = await this.command(
          "EVAL",
          COMPLETE_SCRIPT,
          2,
          this.seenKey,
          this.lockKey(updateKey),
          updateKey,
          token,
          timestamp,
        );
        if (completed === 1) {
          this.seenUpdates.add(updateKey);
          return;
        }

        if ((await this.command("HGET", this.seenKey, updateKey)) !== null) {
          this.seenUpdates.add(updateKey);
          return;
        }
        throw new Error(`สิทธิ์ส่ง ${updateKey} หมดอายุก่อนบันทึกผล`);
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(attempt * 500);
      }
    }
    throw lastError;
  }

  async release(updateKey, token) {
    await this.releaseLock(this.lockKey(updateKey), token);
  }

  async releaseLock(lockKey, token) {
    const script =
      "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
      "return redis.call('DEL', KEYS[1]) else return 0 end";
    return this.command("EVAL", script, 1, lockKey, token);
  }

  async keepAliveIfDue() {
    const lastActivity = Math.max(this.lastAccessAt, this.lastKeepaliveAttemptAt);
    if (Date.now() - lastActivity < this.keepaliveMs) return;
    this.lastKeepaliveAttemptAt = Date.now();
    this.ready = (await this.command("GET", this.readyKey)) === READY;
  }

  async testConnection() {
    const testKey = `${this.key}:connection-test:${randomUUID()}`;
    let created = false;
    try {
      await this.command("SET", testKey, "ok", "EX", 60);
      created = true;
      if ((await this.command("GET", testKey)) !== "ok") {
        throw new Error("ค่าที่อ่านกลับมาไม่ตรงกับค่าที่บันทึก");
      }
    } finally {
      if (created) await this.command("DEL", testKey).catch(() => {});
    }
  }
}

export function createStateStore(config) {
  return new UpstashStateStore({
    url: config.upstashRestUrl,
    token: config.upstashRestToken,
    key: config.stateKey,
    timeoutMs: config.requestTimeoutMs,
    keepaliveMs: config.upstashKeepaliveMs,
  });
}
