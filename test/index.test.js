import assert from "node:assert/strict";
import { createServer as createMockServer } from "node:http";
import test from "node:test";

import {
  buildWebhookPayload,
  collectEvents,
  createHttpServer,
  getConfig,
  selectEvents,
  sendWebhook,
  STATUS_COLORS,
  UpstashStateStore,
} from "../src/index.js";

const VALID_ENV = {
  URL_WEBHOOK: "https://discord.com/api/webhooks/id/token",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

function incident(overrides = {}) {
  return {
    id: "incident-1",
    name: "API errors",
    status: "investigating",
    impact: "major",
    shortlink: "https://stspg.io/example",
    incident_updates: [
      {
        id: "update-2",
        status: "investigating",
        body: "We are investigating.",
        display_at: "2026-09-11T02:00:00.000Z",
        affected_components: [{ name: "API" }],
      },
      {
        id: "update-1",
        status: "investigating",
        body: "First update.",
        display_at: "2026-09-11T01:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

test("collectEvents เรียงอัปเดตจากเก่าไปใหม่", () => {
  const events = collectEvents([incident()]);
  assert.deepEqual(
    events.map((event) => event.update.id),
    ["update-1", "update-2"],
  );
});

test("ครั้งแรกแจ้งเฉพาะอัปเดตล่าสุดของเหตุที่ยังไม่จบ", () => {
  const events = collectEvents([
    incident(),
    incident({
      id: "resolved",
      status: "resolved",
      incident_updates: [
        {
          id: "resolved-update-2",
          status: "resolved",
          body: "Resolved.",
          display_at: "2026-09-10T02:00:00.000Z",
        },
        {
          id: "resolved-update-1",
          status: "investigating",
          body: "Investigating.",
          display_at: "2026-09-10T01:00:00.000Z",
        },
      ],
    }),
  ]);
  const plan = selectEvents(events, {}, true);

  assert.deepEqual(
    plan.notifications.map((event) => event.key),
    ["incident:update-2"],
  );
  assert.equal(plan.baselineKeys.length, 3);
});

test("รอบถัดไปแจ้งทุก update ที่ยังไม่เคยส่ง", () => {
  const events = collectEvents([incident()]);
  const plan = selectEvents(events, { "incident:update-1": "seen" }, false);

  assert.deepEqual(
    plan.notifications.map((event) => event.key),
    ["incident:update-2"],
  );
});

test("payload เป็น Discord embed ภาษาไทยและปิด mentions", () => {
  const [event] = collectEvents([
    incident({ incident_updates: [incident().incident_updates[0]] }),
  ]);
  const payload = buildWebhookPayload(event, "Asia/Bangkok");

  assert.equal(payload.embeds[0].title, "API errors");
  assert.equal(payload.embeds[0].color, STATUS_COLORS.investigating);
  assert.equal(payload.embeds[0].fields[0].value, "กำลังตรวจสอบ");
  assert.equal(payload.username, "Status Monitor");
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("ไม่อ้างว่าไม่มีผลกระทบเมื่อ API ส่ง impact เป็น none", () => {
  const [event] = collectEvents([
    incident({
      impact: "none",
      components: [],
      incident_updates: [
        {
          id: "update-unknown-impact",
          status: "investigating",
          body: "We are investigating.",
          display_at: "2026-09-15T14:26:02.255Z",
          affected_components: null,
        },
      ],
    }),
  ]);
  const payload = buildWebhookPayload(event, "Asia/Bangkok");

  assert.equal(payload.embeds[0].fields[1].value, "ไม่ทราบ (API ไม่ได้ระบุ)");
  assert.equal(payload.embeds[0].fields[3].value, "ไม่ทราบ (API ไม่ได้ระบุ)");
});

test("แสดงการเปลี่ยนสถานะของระบบที่ได้รับผลกระทบ", () => {
  const [event] = collectEvents([
    incident({
      incident_updates: [
        {
          id: "update-component",
          status: "investigating",
          body: "Investigating.",
          display_at: "2026-09-15T14:26:02.255Z",
          affected_components: [
            {
              name: "Media Proxy",
              old_status: "operational",
              new_status: "degraded_performance",
            },
          ],
        },
      ],
    }),
  ]);

  assert.equal(
    buildWebhookPayload(event).embeds[0].fields[3].value,
    "Media Proxy — ปกติ → ประสิทธิภาพลดลง",
  );
});

test("สี Embed ตรงกับทุกสถานะ", () => {
  for (const [status, color] of Object.entries(STATUS_COLORS)) {
    const [event] = collectEvents([
      incident({
        status,
        incident_updates: [
          {
            id: `update-${status}`,
            status,
            body: status,
            display_at: "2026-09-11T02:00:00.000Z",
          },
        ],
      }),
    ]);
    assert.equal(buildWebhookPayload(event).embeds[0].color, color, status);
  }
});

test("config ปฏิเสธ interval ที่ถี่เกินไป", () => {
  assert.throws(
    () =>
      getConfig({
        ...VALID_ENV,
        POLL_INTERVAL_SECONDS: "5",
      }),
    /15/,
  );
});

test("config ใช้รอบตรวจเริ่มต้น 15 วินาที", () => {
  assert.equal(getConfig(VALID_ENV).pollIntervalMs, 15000);
});

test("ไม่ retry ทันทีเมื่อ Discord ตอบ 5xx เพื่อป้องกันการส่งซ้ำ", async () => {
  let requests = 0;
  const server = createMockServer((request, response) => {
    requests += 1;
    response.writeHead(500).end("temporary error");
  });
  await new Promise((resolvePromise) =>
    server.listen(0, "127.0.0.1", resolvePromise),
  );

  try {
    const address = server.address();
    await assert.rejects(
      sendWebhook(
        `http://127.0.0.1:${address.port}/webhook`,
        { content: "test" },
        1000,
      ),
      /HTTP 500/,
    );
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("config บังคับให้กำหนด Upstash URL และ token", () => {
  assert.throws(
    () =>
      getConfig({
        URL_WEBHOOK: "https://discord.com/api/webhooks/id/token",
        UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      }),
    /UPSTASH_REDIS_REST_TOKEN/,
  );
  assert.throws(
    () =>
      getConfig({
        URL_WEBHOOK: "https://discord.com/api/webhooks/id/token",
      }),
    /UPSTASH_REDIS_REST_URL/,
  );
});

test("health endpoint ตอบสั้นและรายงาน RAM", async () => {
  const runtime = {
    startedAt: "2026-09-11T00:00:00.000Z",
    inProgress: false,
    lastCheckAt: null,
    lastSuccessAt: null,
    lastError: null,
    totalNotificationsSent: 0,
    stateEntries: 0,
    stateBackend: "upstash",
  };
  const server = createHttpServer(runtime);
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));

  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "discord-status-webhook");
    assert.equal(body.polling.stateBackend, "upstash");
    assert.equal(typeof body.memory.rssMb, "number");
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("Upstash ย้าย state เดิมและใช้ lock ป้องกันหลาย instance ส่งซ้ำ", async () => {
  const strings = new Map([
    [
      "test:state",
      JSON.stringify({
        version: 1,
        seenUpdates: { "incident:legacy": "2026-09-10T00:00:00.000Z" },
      }),
    ],
  ]);
  const hashes = new Map();
  const authorizations = [];
  const mockServer = createMockServer(async (request, response) => {
    authorizations.push(request.headers.authorization);
    let rawBody = "";
    for await (const chunk of request) rawBody += chunk;
    const parts = JSON.parse(rawBody);
    const [command, key, ...args] = parts;
    const send = (result) => response.end(JSON.stringify({ result }));

    if (command === "GET") {
      send(strings.get(key) ?? null);
      return;
    }
    if (command === "SET") {
      const [value, ...options] = args;
      if (options.includes("NX") && strings.has(key)) {
        send(null);
        return;
      }
      strings.set(key, value);
      send("OK");
      return;
    }
    if (command === "DEL") {
      send(Number(strings.delete(key)));
      return;
    }
    if (command === "HKEYS") {
      send([...((hashes.get(key) || new Map()).keys())]);
      return;
    }
    if (command === "HGET") {
      send(hashes.get(key)?.get(args[0]) ?? null);
      return;
    }
    if (command === "HSET") {
      const hash = hashes.get(key) || new Map();
      for (let index = 0; index < args.length; index += 2) {
        hash.set(args[index], args[index + 1]);
      }
      hashes.set(key, hash);
      send(args.length / 2);
      return;
    }
    if (command === "EVAL") {
      const script = parts[1];
      if (script.includes("HEXISTS")) {
        const [, , , seenKey, lockKey, updateKey, token] = parts;
        if (hashes.get(seenKey)?.has(updateKey)) {
          send("sent");
        } else if (strings.has(lockKey)) {
          send("pending");
        } else {
          strings.set(lockKey, token);
          send("acquired");
        }
        return;
      }
      if (script.includes("HSET")) {
        const [, , , seenKey, lockKey, updateKey, token, timestamp] = parts;
        if (strings.get(lockKey) !== token) {
          send(0);
          return;
        }
        const hash = hashes.get(seenKey) || new Map();
        hash.set(updateKey, timestamp);
        hashes.set(seenKey, hash);
        strings.delete(lockKey);
        send(1);
        return;
      }
      const lockKey = parts[3];
      const token = parts[4];
      const deleted = strings.get(lockKey) === token && strings.delete(lockKey);
      send(Number(deleted));
      return;
    }
    response.writeHead(400).end(JSON.stringify({ error: "unknown command" }));
  });
  await new Promise((resolvePromise) =>
    mockServer.listen(0, "127.0.0.1", resolvePromise),
  );

  try {
    const address = mockServer.address();
    const options = {
      url: `http://127.0.0.1:${address.port}`,
      token: "test-token",
      key: "test:state",
      timeoutMs: 1000,
      keepaliveMs: 21600000,
    };
    const initializer = new UpstashStateStore(options);
    await initializer.load();
    assert.equal(initializer.ready, false);
    assert.equal(await initializer.initialize(["incident:baseline"]), true);
    assert.equal(initializer.has("incident:legacy"), true);
    assert.equal(initializer.has("incident:baseline"), true);

    const first = new UpstashStateStore(options);
    const second = new UpstashStateStore(options);
    await Promise.all([first.load(), second.load()]);
    const claims = await Promise.all([
      first.claim("incident:new"),
      second.claim("incident:new"),
    ]);
    assert.deepEqual(
      claims.map(({ status }) => status).sort(),
      ["acquired", "pending"],
    );

    const winnerIndex = claims.findIndex(({ status }) => status === "acquired");
    const winner = winnerIndex === 0 ? first : second;
    const other = winnerIndex === 0 ? second : first;
    await winner.complete("incident:new", claims[winnerIndex].token);
    assert.equal((await other.claim("incident:new")).status, "sent");

    const reader = new UpstashStateStore(options);
    await reader.load();
    assert.equal(reader.has("incident:new"), true);
    assert.equal(reader.stateEntries, 3);
    assert.equal(reader.backend, "upstash");
    await reader.testConnection();
    assert.equal(
      authorizations.every((value) => value === "Bearer test-token"),
      true,
    );
  } finally {
    await new Promise((resolvePromise) => mockServer.close(resolvePromise));
  }
});
