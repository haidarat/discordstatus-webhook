import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { getConfig, loadEnvFile } from "./config.js";
import { createHttpServer } from "./health-server.js";
import {
  buildWebhookPayload,
  checkOnce,
  collectEvents,
  selectEvents,
  sendWebhook,
  STATUS_COLORS,
  testWebhookPayload,
} from "./monitor.js";
import { createStateStore, UpstashStateStore } from "./state-store.js";
import { truncate } from "./shared.js";

export {
  buildWebhookPayload,
  collectEvents,
  createHttpServer,
  createStateStore,
  getConfig,
  loadEnvFile,
  selectEvents,
  sendWebhook,
  STATUS_COLORS,
  UpstashStateStore,
};

function listen(server, port) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolvePromise) => server.close(resolvePromise));
}

function createInterruptibleDelay() {
  let cancelCurrent = null;
  return {
    wait(milliseconds) {
      return new Promise((resolvePromise) => {
        const finish = () => {
          cancelCurrent = null;
          resolvePromise();
        };
        const timer = setTimeout(finish, milliseconds);
        cancelCurrent = () => {
          clearTimeout(timer);
          finish();
        };
      });
    },
    cancel() {
      cancelCurrent?.();
    },
  };
}

async function runConnectionTest(config) {
  const store = createStateStore(config);
  await store.testConnection();
  console.log("ทดสอบ Upstash สำเร็จ (SET/GET/DEL)");
}

async function runMonitor(config, runOnce) {
  const store = createStateStore(config);
  await store.load();

  const runtime = {
    startedAt: new Date().toISOString(),
    inProgress: false,
    lastCheckAt: null,
    lastSuccessAt: null,
    lastError: null,
    totalNotificationsSent: 0,
    stateEntries: store.stateEntries,
    stateBackend: store.backend,
  };
  const server = runOnce ? null : createHttpServer(runtime);
  const pollDelay = createInterruptibleDelay();
  let stopping = false;

  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    console.log("กำลังหยุด...");
    server?.close();
    pollDelay.cancel();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  if (server) {
    await listen(server, config.port);
    console.log(`HTTP health endpoint พร้อมใช้งานที่ 0.0.0.0:${config.port}/health`);
  }
  console.log(
    `เริ่มตรวจ Discord Status ทุก ${config.pollIntervalMs / 1000} วินาที` +
      (config.includeMaintenance ? " (รวมการบำรุงรักษา)" : "") +
      ` • state: ${store.backend}`,
  );

  do {
    runtime.inProgress = true;
    runtime.lastCheckAt = new Date().toISOString();
    try {
      const sent = await checkOnce(config, store);
      runtime.lastSuccessAt = new Date().toISOString();
      runtime.lastError = null;
      runtime.totalNotificationsSent += sent;
    } catch (error) {
      console.error(`[ผิดพลาด] ${error.message}`);
      runtime.lastError = truncate(error.message, 300);
      if (runOnce) process.exitCode = 1;
    } finally {
      runtime.inProgress = false;
      runtime.stateEntries = store.stateEntries;
    }

    if (runOnce || stopping) break;
    await pollDelay.wait(config.pollIntervalMs);
  } while (!stopping);

  await close(server);
}

async function main() {
  await loadEnvFile();
  const config = getConfig();
  const args = new Set(process.argv.slice(2));

  if (args.has("--test-webhook")) {
    await sendWebhook(
      config.webhookUrl,
      testWebhookPayload(),
      config.requestTimeoutMs,
    );
    console.log("ส่งข้อความทดสอบสำเร็จ");
    return;
  }
  if (args.has("--test-database")) {
    await runConnectionTest(config);
    return;
  }

  await runMonitor(config, args.has("--once"));
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(`[หยุดทำงาน] ${error.message}`);
    process.exitCode = 1;
  });
}
