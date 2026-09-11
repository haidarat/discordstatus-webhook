import { createServer } from "node:http";
import process from "node:process";

function memoryUsage() {
  const usage = process.memoryUsage();
  const toMegabytes = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
  return {
    rssMb: toMegabytes(usage.rss),
    heapUsedMb: toMegabytes(usage.heapUsed),
    heapTotalMb: toMegabytes(usage.heapTotal),
  };
}

function sendJson(request, response, statusCode, body) {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(serialized),
    "Cache-Control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : serialized);
}

export function createHttpServer(runtime) {
  return createServer((request, response) => {
    if (!["GET", "HEAD"].includes(request.method || "")) {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(request, response, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    const path = new URL(request.url || "/", "http://localhost").pathname;
    if (path === "/favicon.ico") {
      response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      response.end();
      return;
    }

    if (path === "/" || path === "/health") {
      sendJson(request, response, 200, {
        ok: true,
        service: "discord-status-webhook",
        message: "Discord Status monitor is running",
        startedAt: runtime.startedAt,
        uptimeSeconds: Math.floor(process.uptime()),
        polling: {
          inProgress: runtime.inProgress,
          lastCheckAt: runtime.lastCheckAt,
          lastSuccessAt: runtime.lastSuccessAt,
          lastError: runtime.lastError,
          totalNotificationsSent: runtime.totalNotificationsSent,
          stateEntries: runtime.stateEntries,
          stateBackend: runtime.stateBackend,
        },
        memory: memoryUsage(),
      });
      return;
    }

    sendJson(request, response, 404, { ok: false, error: "Not found" });
  });
}
