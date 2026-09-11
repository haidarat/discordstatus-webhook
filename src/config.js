import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

function parseEnvLine(line) {
  const match = line.match(
    /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/,
  );
  if (!match) return null;

  let value = match[2] ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return [match[1], value];
}

export async function loadEnvFile(path = resolve(".env")) {
  try {
    const contents = await readFile(path, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const entry = parseEnvLine(line);
      if (entry && process.env[entry[0]] === undefined) {
        process.env[entry[0]] = entry[1];
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function parseInteger(value, fallback, minimum, name) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} ต้องเป็นจำนวนเต็มตั้งแต่ ${minimum} ขึ้นไป`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} ต้องเป็นจำนวนเต็มตั้งแต่ ${minimum} ขึ้นไป`);
  }
  return parsed;
}

function parsePort(value) {
  const port = parseInteger(value, 3000, 1, "PORT");
  if (port > 65535) throw new Error("PORT ต้องไม่เกิน 65535");
  return port;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`ค่าบูลีนไม่ถูกต้อง: ${value}`);
}

function parseHttpsUrl(value, name) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${name} ต้องเป็น HTTPS URL ที่ถูกต้อง`);
  }
}

export function getConfig(env = process.env) {
  if (!env.URL_WEBHOOK) {
    throw new Error("ไม่พบ URL_WEBHOOK กรุณาสร้างไฟล์ .env และกำหนด URL_WEBHOOK");
  }
  const webhookUrl = parseHttpsUrl(env.URL_WEBHOOK, "URL_WEBHOOK");

  const upstashRestUrl = env.UPSTASH_REDIS_REST_URL || "";
  const upstashRestToken = env.UPSTASH_REDIS_REST_TOKEN || "";
  if (!upstashRestUrl || !upstashRestToken) {
    throw new Error(
      "ต้องกำหนด UPSTASH_REDIS_REST_URL และ UPSTASH_REDIS_REST_TOKEN",
    );
  }

  const timeZone = env.TIME_ZONE || "Asia/Bangkok";
  try {
    new Intl.DateTimeFormat("th-TH", { timeZone }).format();
  } catch {
    throw new Error(`TIME_ZONE ไม่ถูกต้อง: ${timeZone}`);
  }

  return {
    webhookUrl,
    pollIntervalMs:
      parseInteger(env.POLL_INTERVAL_SECONDS, 15, 15, "POLL_INTERVAL_SECONDS") *
      1000,
    includeMaintenance: parseBoolean(env.INCLUDE_MAINTENANCE, true),
    timeZone,
    requestTimeoutMs:
      parseInteger(env.REQUEST_TIMEOUT_SECONDS, 15, 1, "REQUEST_TIMEOUT_SECONDS") *
      1000,
    port: parsePort(env.PORT),
    upstashRestUrl: parseHttpsUrl(upstashRestUrl, "UPSTASH_REDIS_REST_URL"),
    upstashRestToken,
    stateKey: env.STATE_KEY || "discord-status-webhook:state",
    upstashKeepaliveMs:
      parseInteger(
        env.UPSTASH_KEEPALIVE_SECONDS,
        21600,
        300,
        "UPSTASH_KEEPALIVE_SECONDS",
      ) * 1000,
  };
}
