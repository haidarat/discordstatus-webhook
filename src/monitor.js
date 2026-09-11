import { fetchWithTimeout, sleep, truncate } from "./shared.js";

const STATUS_API = "https://discordstatus.com/api/v2/incidents.json";
const MAINTENANCE_API =
  "https://discordstatus.com/api/v2/scheduled-maintenances.json";
const STATUS_PAGE = "https://discordstatus.com/";

const STATUS_LABELS = {
  investigating: "กำลังตรวจสอบ",
  identified: "พบสาเหตุแล้ว",
  monitoring: "กำลังเฝ้าระวัง",
  resolved: "แก้ไขแล้ว",
  postmortem: "รายงานสรุปเหตุการณ์",
  scheduled: "มีกำหนดการ",
  in_progress: "กำลังดำเนินการ",
  verifying: "กำลังตรวจสอบผล",
  completed: "เสร็จสิ้น",
};

const IMPACT_LABELS = {
  minor: "เล็กน้อย",
  major: "รุนแรง",
  critical: "วิกฤต",
};

const COMPONENT_STATUS_LABELS = {
  operational: "ปกติ",
  degraded_performance: "ประสิทธิภาพลดลง",
  partial_outage: "ขัดข้องบางส่วน",
  major_outage: "ขัดข้องรุนแรง",
  under_maintenance: "อยู่ระหว่างบำรุงรักษา",
};

const UNKNOWN_API_VALUE = "ไม่ทราบ (API ไม่ได้ระบุ)";

export const STATUS_COLORS = {
  investigating: 0xed4245,
  identified: 0xf97316,
  monitoring: 0x3498db,
  resolved: 0x57f287,
  postmortem: 0x9b59b6,
  scheduled: 0x5865f2,
  in_progress: 0xf59e0b,
  verifying: 0x00b0f4,
  completed: 0x57f287,
  default: 0x95a5a6,
};

function activeEntity(kind, status) {
  if (kind === "incident") {
    return !["resolved", "postmortem"].includes(status);
  }
  return status !== "completed";
}

function eventTime(event) {
  return Date.parse(
    event.update.display_at || event.update.created_at || event.entity.created_at,
  );
}

export function collectEvents(incidents, maintenances = []) {
  const sources = [
    ...incidents.map((entity) => ({ kind: "incident", entity })),
    ...maintenances.map((entity) => ({ kind: "maintenance", entity })),
  ];

  return sources
    .flatMap(({ kind, entity }) =>
      (entity.incident_updates || []).map((update) => ({
        key: `${kind}:${update.id}`,
        kind,
        entity,
        update,
      })),
    )
    .sort((a, b) => eventTime(a) - eventTime(b));
}

export function selectEvents(events, seenUpdates, isFirstRun) {
  if (!isFirstRun) {
    return {
      baselineKeys: [],
      notifications: events.filter((event) => !seenUpdates[event.key]),
    };
  }

  const latestActiveByEntity = new Map();
  for (const event of events) {
    if (activeEntity(event.kind, event.entity.status)) {
      latestActiveByEntity.set(`${event.kind}:${event.entity.id}`, event);
    }
  }

  const notifications = [...latestActiveByEntity.values()].sort(
    (a, b) => eventTime(a) - eventTime(b),
  );
  const notificationKeys = new Set(notifications.map((event) => event.key));

  return {
    baselineKeys: events
      .filter((event) => !notificationKeys.has(event.key))
      .map((event) => event.key),
    notifications,
  };
}

function formatDate(value, timeZone) {
  if (!value) return "ไม่ระบุ";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "ไม่ทราบ (เวลาไม่ถูกต้อง)";
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone,
  }).format(date);
}

function statusLabel(status) {
  if (!status) return UNKNOWN_API_VALUE;
  return STATUS_LABELS[status] || `ไม่ทราบ (${status})`;
}

function impactLabel(impact) {
  if (!impact || impact === "none") return UNKNOWN_API_VALUE;
  return IMPACT_LABELS[impact] || `ไม่ทราบ (${impact})`;
}

function componentStatusLabel(status) {
  return COMPONENT_STATUS_LABELS[status] || status || null;
}

function affectedComponents(entity, update) {
  const components = update.affected_components ?? entity.components ?? [];
  if (!components.length) return UNKNOWN_API_VALUE;

  return components
    .map((component) => {
      const name = component.name || "ไม่ทราบชื่อระบบ";
      const oldStatus = componentStatusLabel(component.old_status);
      const newStatus = componentStatusLabel(
        component.new_status || component.status,
      );
      if (oldStatus && newStatus && oldStatus !== newStatus) {
        return `${name} — ${oldStatus} → ${newStatus}`;
      }
      return newStatus ? `${name} — ${newStatus}` : name;
    })
    .join("\n");
}

export function buildWebhookPayload(event, timeZone = "Asia/Bangkok") {
  const { entity, update, kind } = event;
  const typeLabel = kind === "incident" ? "เหตุขัดข้อง" : "การบำรุงรักษา";
  const updateStatus = update.status || entity.status;
  const fields = [
    {
      name: "สถานะ",
      value: statusLabel(updateStatus),
      inline: true,
    },
    {
      name: "ผลกระทบ",
      value: impactLabel(entity.impact),
      inline: true,
    },
    {
      name: "เวลาประกาศ",
      value: formatDate(update.display_at || update.created_at, timeZone),
      inline: false,
    },
  ];

  if (kind === "incident") {
    fields.push({
      name: "ระบบที่ได้รับผลกระทบ",
      value: truncate(affectedComponents(entity, update), 1024),
      inline: false,
    });
  } else if (entity.scheduled_for) {
    fields.push({
      name: "ช่วงเวลาบำรุงรักษา",
      value: `${formatDate(entity.scheduled_for, timeZone)} – ${formatDate(entity.scheduled_until, timeZone)}`,
      inline: false,
    });
  }

  return {
    // Discord rejects webhook usernames containing the word "Discord".
    username: "Status Monitor",
    avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: truncate(entity.name || "ไม่ทราบชื่อเหตุการณ์", 256),
        url: entity.shortlink || STATUS_PAGE,
        description: truncate(update.body || UNKNOWN_API_VALUE, 4096),
        color: STATUS_COLORS[updateStatus] ?? STATUS_COLORS.default,
        fields,
        footer: { text: `Discord Status • ${typeLabel}` },
        timestamp:
          update.display_at ||
          update.created_at ||
          entity.updated_at ||
          new Date().toISOString(),
      },
    ],
  };
}

export function testWebhookPayload() {
  return {
    username: "Status Monitor",
    avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: "ทดสอบการเชื่อมต่อสำเร็จ",
        url: STATUS_PAGE,
        description: "Webhook พร้อมรับประกาศใหม่จาก Discord Status แล้ว",
        color: 0x57f287,
        footer: { text: "Discord Status • ข้อความทดสอบ" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function fetchJson(url, timeoutMs) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "discord-status-webhook/1.0",
      },
    },
    timeoutMs,
  );
  if (!response.ok) {
    throw new Error(`Discord Status API ตอบกลับ HTTP ${response.status}`);
  }
  return response.json();
}

function webhookEndpoint(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set("wait", "true");
  return url.toString();
}

export async function sendWebhook(url, payload, timeoutMs) {
  const maximumAttempts = 4;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(
        webhookEndpoint(url),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        timeoutMs,
      );
    } catch (cause) {
      const error = new Error(
        `ไม่สามารถยืนยันผลการส่ง webhook: ${cause.message}`,
        { cause },
      );
      error.deliveryUncertain = true;
      throw error;
    }

    if (response.ok) return;

    if (response.status === 429 && attempt < maximumAttempts) {
      const body = await response.json().catch(() => ({}));
      const retryAfterMs = Math.max(Number(body.retry_after) || 1, 0.25) * 1000;
      await sleep(retryAfterMs);
      continue;
    }

    const body = truncate(await response.text().catch(() => ""), 300);
    const error = new Error(
      `ส่ง webhook ไม่สำเร็จ (HTTP ${response.status})${body ? `: ${body}` : ""}`,
    );
    error.deliveryUncertain = response.status >= 500;
    throw error;
  }
}

export async function checkOnce(config, store) {
  const requests = [fetchJson(STATUS_API, config.requestTimeoutMs)];
  if (config.includeMaintenance) {
    requests.push(fetchJson(MAINTENANCE_API, config.requestTimeoutMs));
  }
  const [incidentData, maintenanceData] = await Promise.all(requests);
  const events = collectEvents(
    incidentData.incidents || [],
    maintenanceData?.scheduled_maintenances || [],
  );

  try {
    await store.keepAliveIfDue();
  } catch (error) {
    console.warn(`[คำเตือน] รักษาการเชื่อมต่อ state ไม่สำเร็จ: ${error.message}`);
  }

  let notifications;
  if (!store.ready) {
    const plan = selectEvents(events, {}, true);
    if (!(await store.initialize(plan.baselineKeys))) return 0;
    notifications = plan.notifications;
    console.log(
      `[เริ่มต้น] บันทึกประวัติ ${plan.baselineKeys.length} รายการ โดยไม่ส่งเหตุการณ์เก่า`,
    );
  } else {
    notifications = events.filter((event) => !store.has(event.key));
  }

  let sent = 0;
  for (const event of notifications) {
    if (store.has(event.key)) continue;
    const claim = await store.claim(event.key);
    if (claim.status !== "acquired") continue;

    try {
      await sendWebhook(
        config.webhookUrl,
        buildWebhookPayload(event, config.timeZone),
        config.requestTimeoutMs,
      );
    } catch (error) {
      if (error.deliveryUncertain) {
        await store.complete(event.key, claim.token);
        console.warn(
          `[คำเตือน] ผลการส่ง ${event.key} ไม่แน่นอน จึงบันทึกว่าใช้แล้วเพื่อป้องกันข้อความซ้ำ`,
        );
      } else {
        await store.release(event.key, claim.token).catch(() => {});
      }
      throw error;
    }
    await store.complete(event.key, claim.token);
    sent += 1;
    console.log(
      `[ส่งแล้ว] ${event.entity.name} — ${statusLabel(event.update.status)}`,
    );
  }
  return sent;
}
