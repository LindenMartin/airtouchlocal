"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildAirflowStepCommand,
  buildControlCommand,
  buildGroupNameCommand,
  extractStatus,
  parseStatus,
  queryCommand,
  StatusPacket
} = require("./protocol");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const AIRCON_HOST = process.env.AIRCON_HOST || "10.0.0.200";
const AIRCON_USER = process.env.AIRCON_USER || "admin";
const AIRCON_PASSWORD = process.env.AIRCON_PASSWORD || "admin";
const APP_USERNAME = process.env.APP_USERNAME || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const PUBLIC = path.join(__dirname, "public");
const BACKUPS = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, "backups"));
const authorization = `Basic ${Buffer.from(`${AIRCON_USER}:${AIRCON_PASSWORD}`).toString("base64")}`;
if (Boolean(APP_USERNAME) !== Boolean(APP_PASSWORD)) {
  throw new Error("APP_USERNAME and APP_PASSWORD must either both be set or both be empty");
}
const appAuthorization = APP_USERNAME && APP_PASSWORD
  ? `Basic ${Buffer.from(`${APP_USERNAME}:${APP_PASSWORD}`).toString("base64")}`
  : null;

fs.mkdirSync(BACKUPS, { recursive: true });

let queue = Promise.resolve();
const eventClients = new Set();
let eventSequence = 0;

function exclusive(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function broadcastStatus(status) {
  eventSequence += 1;
  const message = `id: ${eventSequence}\nevent: status\ndata: ${JSON.stringify(status)}\n\n`;
  eventClients.forEach((client) => {
    try {
      client.write(message);
    } catch {
      eventClients.delete(client);
    }
  });
}

function openEventStream(request, response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.write("retry: 3000\n\n");
  eventClients.add(response);
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 25_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(response);
  });
}

function controllerGet(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: AIRCON_HOST,
      port: 80,
      path: pathname,
      headers: { Authorization: authorization },
      timeout: 5000
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Controller returned HTTP ${response.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Controller timed out")));
    request.on("error", reject);
  });
}

async function uartWrite(hex) {
  await controllerGet(`/httpapi.json?&sndtime=${Math.random()}&CMD=UART_WRITE&UWHEXVAL=${hex}`);
}

async function uartRead() {
  return controllerGet(`/httpapi.json?&sndtime=${Math.random()}&CMD=UART_READ`);
}

async function readStatus() {
  await uartWrite(queryCommand());
  await delay(1000);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const statusHex = extractStatus(await uartRead());
    if (statusHex) {
      const status = parseStatus(statusHex);
      ensureGoldenBackup(status);
      return status;
    }
    await delay(120);
  }
  throw new Error("No valid status reply received from the controller");
}

function ensureGoldenBackup(status) {
  const hasGolden = fs.readdirSync(BACKUPS)
    .filter((name) => name.endsWith(".json"))
    .some((name) => {
      try {
        return Boolean(JSON.parse(fs.readFileSync(path.join(BACKUPS, name), "utf8")).golden);
      } catch {
        return false;
      }
    });
  if (hasGolden) return;
  saveBackupFile(backupDocument(status), {
    golden: true,
    label: "Original state"
  });
  console.log("Captured immutable first-run golden backup");
}

async function updateControl(desired) {
  const current = await readStatus();
  const command = buildControlCommand(current, desired);
  await uartWrite(command);
  await delay(350);
  return readStatus();
}

async function updateAirflow(groupId, percent) {
  if (!Number.isInteger(groupId) || !Number.isInteger(percent) || percent < 10 || percent > 100 || percent % 10 !== 0) {
    throw new Error("Airflow must be 10–100% in 10% steps");
  }

  let current = await readStatus();
  const group = current.groups.find((item) => item.id === groupId);
  if (!group) throw new Error("Unknown AirTouch group");
  if (!group.on) throw new Error(`${group.name} must be on before changing airflow`);
  if (group.spill) throw new Error(`${group.name} is controlled automatically while spill is active`);
  if (group.turbo) throw new Error("Airflow cannot be adjusted while Turbo is active");

  const difference = percent - group.openPercent;
  const direction = difference > 0 ? "up" : "down";
  const steps = Math.abs(difference) / 10;

  for (let index = 0; index < steps; index += 1) {
    await uartWrite(buildAirflowStepCommand(groupId, direction));
    await delay(140);
  }

  current = await readStatus();
  const updated = current.groups.find((item) => item.id === groupId);
  if (updated?.openPercent !== percent) {
    throw new Error(`Controller reported ${updated?.openPercent ?? "unknown"}% instead of ${percent}%`);
  }
  return current;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateBackup(value) {
  if (value?.format !== "airtouch-local-backup" || value.version !== 1) {
    throw new Error("Unsupported AirTouch backup format");
  }
  if (!Array.isArray(value.decoded?.groups) || !value.statusPacket?.hex) {
    throw new Error("Backup is missing decoded groups or status packet");
  }
  const packet = new StatusPacket(value.statusPacket.hex);
  if (!packet.checksumValid()) throw new Error("Backup status packet checksum is invalid");
  value.decoded.groups.forEach((group) => {
    if (!Number.isInteger(group.id) || typeof group.name !== "string" ||
        !Number.isInteger(group.openPercent) || group.openPercent < 10 ||
        group.openPercent > 100 || group.openPercent % 10 !== 0) {
      throw new Error("Backup contains an invalid group");
    }
  });
  return value;
}

function backupId(value, golden = false) {
  const stamp = value.capturedAt.replace(/[:.]/g, "-");
  return `${golden ? "golden-original" : "snapshot"}-${stamp}.json`;
}

function saveBackupFile(value, options = {}) {
  const backup = validateBackup({
    ...value,
    label: options.label || value.label || (options.golden ? "Original state" : "Controller snapshot"),
    golden: Boolean(options.golden || value.golden)
  });
  const id = options.id || backupId(backup, backup.golden);
  if (!/^[a-z0-9._-]+\.json$/i.test(id)) throw new Error("Invalid backup filename");
  const destination = path.join(BACKUPS, id);
  if (!destination.startsWith(BACKUPS + path.sep)) throw new Error("Invalid backup path");
  if (backup.golden && fs.existsSync(destination) && !options.allowExisting) {
    throw new Error("The original golden backup is immutable");
  }
  fs.writeFileSync(destination, JSON.stringify(backup, null, 2));
  return { id, backup };
}

function readBackupFile(id) {
  if (!/^[a-z0-9._-]+\.json$/i.test(id)) throw new Error("Invalid backup id");
  const filename = path.join(BACKUPS, id);
  if (!filename.startsWith(BACKUPS + path.sep) || !fs.existsSync(filename)) {
    throw new Error("Backup not found");
  }
  return validateBackup(JSON.parse(fs.readFileSync(filename, "utf8")));
}

function backupSummary(id, backup) {
  return {
    id,
    label: backup.label || "Controller snapshot",
    golden: Boolean(backup.golden),
    capturedAt: backup.capturedAt,
    checksumValid: Boolean(backup.statusPacket.checksumValid),
    controller: backup.controller,
    state: {
      on: Boolean(backup.decoded.on),
      temperature: backup.decoded.temperature,
      groups: backup.decoded.groups.map(({ id: groupId, name, on, openPercent }) => ({
        id: groupId, name, on, openPercent
      }))
    }
  };
}

function listBackups() {
  return fs.readdirSync(BACKUPS)
    .filter((name) => name.endsWith(".json"))
    .map((id) => {
      try {
        const backup = readBackupFile(id);
        return backupSummary(id, backup);
      } catch (error) {
        return { id, invalid: true, error: error.message };
      }
    })
    .sort((left, right) => Number(Boolean(right.golden)) - Number(Boolean(left.golden)) ||
      String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")));
}

async function restoreBackup(backup) {
  validateBackup(backup);
  const before = await readStatus();
  saveBackupFile(backupDocument(before), {
    label: `Automatic pre-restore snapshot (${backup.label || "backup"})`
  });

  const targets = backup.decoded.groups;
  const beforeById = new Map(before.groups.map((group) => [group.id, group]));

  for (const target of targets) {
    const current = beforeById.get(target.id);
    if (current && current.name !== target.name) {
      await uartWrite(buildGroupNameCommand(target.id, target.name));
      await delay(180);
    }
  }

  let current = await readStatus();
  const preparationGroups = {};
  targets.forEach((target) => {
    const group = current.groups.find((item) => item.id === target.id);
    preparationGroups[target.id] = Boolean(target.on || (group && group.openPercent !== target.openPercent));
  });
  await uartWrite(buildControlCommand(current, { on: true, groups: preparationGroups }));
  await delay(350);
  current = await readStatus();

  for (const target of targets) {
    const group = current.groups.find((item) => item.id === target.id);
    if (!group || group.spill || group.openPercent === target.openPercent) continue;
    const difference = target.openPercent - group.openPercent;
    const direction = difference > 0 ? "up" : "down";
    for (let index = 0; index < Math.abs(difference) / 10; index += 1) {
      await uartWrite(buildAirflowStepCommand(target.id, direction));
      await delay(140);
    }
    current = await readStatus();
  }

  await uartWrite(buildControlCommand(current, {
    on: Boolean(backup.decoded.on),
    groups: Object.fromEntries(targets.map((group) => [group.id, Boolean(group.on)]))
  }));
  await delay(350);
  const restored = await readStatus();

  const problems = [];
  if (restored.on !== Boolean(backup.decoded.on)) problems.push("AC power");
  targets.forEach((target) => {
    const actual = restored.groups.find((group) => group.id === target.id);
    if (!actual) problems.push(`${target.name} missing`);
    else {
      if (actual.name !== target.name) problems.push(`${target.name} name`);
      if (actual.on !== Boolean(target.on)) problems.push(`${target.name} state`);
      if (!actual.spill && actual.openPercent !== target.openPercent) problems.push(`${target.name} airflow`);
    }
  });
  if (problems.length) throw new Error(`Restore verification failed: ${problems.join(", ")}`);
  return restored;
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function backupDocument(status) {
  return {
    format: "airtouch-local-backup",
    version: 1,
    capturedAt: new Date().toISOString(),
    controller: AIRCON_HOST,
    warning: "The 353-byte response is not a writable configuration packet. Only use separately verified restore commands.",
    statusPacket: {
      bytes: status.protocol.length,
      checksumValid: status.protocol.checksumValid,
      hex: status.protocol.raw
    },
    decoded: {
      on: status.on,
      temperature: status.temperature,
      owner: status.owner,
      controllerDate: status.controllerDate,
      controllerTime: status.controllerTime,
      timers: status.timers,
      groups: status.groups
    },
    verifiedRestoreCommands: {
      groupNames: status.groups.map((group) => ({
        id: group.id,
        name: group.name,
        command: buildGroupNameCommand(group.id, group.name)
      }))
    }
  };
}

function downloadableJson(response, value) {
  const body = JSON.stringify(value, null, 2);
  const stamp = value.capturedAt.replace(/[:.]/g, "-");
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="airtouch-backup-${stamp}.json"`,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 32_768) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function unauthorized(response) {
  response.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="AirTouch Local", charset="UTF-8"',
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify({ error: "Authentication required" }));
}

function staticFile(request, response) {
  const requestPath = request.url === "/" ? "/index.html" : request.url.split("?")[0];
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC, safePath);

  if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const extension = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  response.writeHead(200, {
    "Content-Type": types[extension] || "application/octet-stream",
    "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=3600"
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'");

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (appAuthorization && !safeEqual(request.headers.authorization, appAuthorization)) {
      unauthorized(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events") {
      openEventStream(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      const status = await exclusive(readStatus);
      json(response, 200, status);
      broadcastStatus(status);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      json(response, 200, {
        controllerHost: AIRCON_HOST,
        appAuthentication: appAuthorization ? "password" : "local-only",
        clockSync: {
          supported: false,
          reason: "No independently verified clock-write command has been identified."
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/backup") {
      downloadableJson(response, backupDocument(await exclusive(readStatus)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/backups") {
      json(response, 200, { backups: listBackups() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/backups") {
      const body = await readJson(request);
      const value = backupDocument(await exclusive(readStatus));
      const saved = saveBackupFile(value, { label: String(body.label || "Controller snapshot").slice(0, 80) });
      json(response, 201, backupSummary(saved.id, saved.backup));
      return;
    }

    const backupMatch = url.pathname.match(/^\/api\/backups\/([^/]+)$/);
    const restoreMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
    if (request.method === "GET" && backupMatch) {
      downloadableJson(response, readBackupFile(decodeURIComponent(backupMatch[1])));
      return;
    }
    if (request.method === "POST" && restoreMatch) {
      const body = await readJson(request);
      if (body.confirm !== true) {
        json(response, 400, { error: "Restore requires explicit confirmation" });
        return;
      }
      const backup = readBackupFile(decodeURIComponent(restoreMatch[1]));
      const status = await exclusive(() => restoreBackup(backup));
      json(response, 200, status);
      broadcastStatus(status);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/control") {
      const body = await readJson(request);
      if (typeof body.on !== "boolean" || (body.groups && typeof body.groups !== "object")) {
        json(response, 400, { error: "Expected an on boolean and optional groups object" });
        return;
      }
      const status = await exclusive(() => updateControl(body));
      json(response, 200, status);
      broadcastStatus(status);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/airflow") {
      const body = await readJson(request);
      const status = await exclusive(() => updateAirflow(Number(body.groupId), Number(body.percent)));
      json(response, 200, status);
      broadcastStatus(status);
      return;
    }

    if (request.method !== "GET") {
      json(response, 405, { error: "Method not allowed" });
      return;
    }
    staticFile(request, response);
  } catch (error) {
    console.error(error);
    json(response, 502, {
      error: error.message,
      hint: `Check that ${AIRCON_HOST} is reachable and AIRCON_USER/AIRCON_PASSWORD are correct.`
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AirTouch Local is ready at http://${HOST}:${PORT}`);
  console.log(`Controller: http://${AIRCON_HOST} (user: ${AIRCON_USER})`);
  console.log(`Backups: ${BACKUPS}`);
  console.log(`App authentication: ${appAuthorization ? "enabled" : "disabled"}`);
});
