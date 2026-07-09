"use strict";

const http = require("node:http");
const https = require("node:https");
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
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.dirname(process.env.BACKUP_DIR || path.join(__dirname, "data", "backups")));
const BACKUPS = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, "backups"));
const SMART_CONFIG_FILE = path.join(DATA_DIR, "smart-config.json");
const EVENT_LOG_FILE = path.join(DATA_DIR, "events.jsonl");
const authorization = `Basic ${Buffer.from(`${AIRCON_USER}:${AIRCON_PASSWORD}`).toString("base64")}`;
if (Boolean(APP_USERNAME) !== Boolean(APP_PASSWORD)) {
  throw new Error("APP_USERNAME and APP_PASSWORD must either both be set or both be empty");
}
const appAuthorization = APP_USERNAME && APP_PASSWORD
  ? `Basic ${Buffer.from(`${APP_USERNAME}:${APP_PASSWORD}`).toString("base64")}`
  : null;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUPS, { recursive: true });

let queue = Promise.resolve();
const eventClients = new Set();
let eventSequence = 0;
let weatherCache = null;
let automationBusy = false;

const defaultSmartConfig = {
  location: {
    name: process.env.WEATHER_LOCATION || "",
    latitude: Number(process.env.WEATHER_LAT || "") || null,
    longitude: Number(process.env.WEATHER_LON || "") || null,
    timezone: process.env.WEATHER_TIMEZONE || "auto"
  },
  weather: {
    enabled: Boolean(process.env.WEATHER_LAT && process.env.WEATHER_LON),
    provider: "open-meteo",
    refreshMinutes: 20
  },
  notifications: {
    enabled: false,
    temperatureThresholds: true,
    indoorHotAt: 28,
    indoorColdAt: 16,
    spill: true,
    automationActions: true,
    controllerOffline: true,
    weatherWarnings: false
  },
  automation: {
    enabled: false,
    modeAssumption: "auto-panel-24",
    coolingRule: {
      enabled: true,
      turnOnAbove: 25,
      turnOffAtOrBelow: 21
    },
    heatingRule: {
      enabled: true,
      turnOnBelow: 15,
      turnOffAtOrAbove: 21
    },
    turnOnAbove: 27,
    turnOffBelow: 24,
    turnOnBelow: 17,
    turnOffAbove: 20,
    minimumRunMinutes: 20,
    minimumRestMinutes: 15,
    evaluateOnRefresh: true,
    activeRule: null,
    lastActionAt: null,
    lastAction: "none"
  },
  integrations: {
    ecowitt: {
      enabled: false,
      note: "Add Ecowitt API or local gateway credentials later; keep cloud URLs and keys out of Git."
    },
    solarBattery: {
      enabled: false,
      note: "Future input for cheap/available solar energy and battery state."
    }
  }
};

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

function broadcastNamedEvent(name, value) {
  eventSequence += 1;
  const message = `id: ${eventSequence}\nevent: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
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

function mergeConfig(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(base);
  const output = structuredClone(base);
  Object.entries(patch).forEach(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && output[key] && typeof output[key] === "object") {
      output[key] = mergeConfig(output[key], value);
    } else {
      output[key] = value;
    }
  });
  return output;
}

function readSmartConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(SMART_CONFIG_FILE, "utf8"));
    return normalizeSmartConfig(mergeConfig(defaultSmartConfig, saved));
  } catch {
    return normalizeSmartConfig(defaultSmartConfig);
  }
}

function normalizeSmartConfig(value) {
  const config = mergeConfig(defaultSmartConfig, value);
  config.location.name = String(config.location.name || "").slice(0, 80);
  config.location.latitude = finiteOrNull(config.location.latitude);
  config.location.longitude = finiteOrNull(config.location.longitude);
  config.location.timezone = String(config.location.timezone || "auto").slice(0, 60);
  config.weather.enabled = Boolean(config.weather.enabled);
  config.weather.provider = "open-meteo";
  config.weather.refreshMinutes = clampInteger(config.weather.refreshMinutes, 5, 180, 20);
  config.notifications.enabled = Boolean(config.notifications.enabled);
  config.notifications.temperatureThresholds = Boolean(config.notifications.temperatureThresholds);
  config.notifications.indoorHotAt = clampInteger(config.notifications.indoorHotAt, 10, 45, 28);
  config.notifications.indoorColdAt = clampInteger(config.notifications.indoorColdAt, 0, 30, 16);
  config.notifications.spill = Boolean(config.notifications.spill);
  config.notifications.automationActions = Boolean(config.notifications.automationActions);
  config.notifications.controllerOffline = Boolean(config.notifications.controllerOffline);
  config.notifications.weatherWarnings = Boolean(config.notifications.weatherWarnings);
  config.automation.enabled = Boolean(config.automation.enabled);
  config.automation.modeAssumption = ["cooling", "heating", "auto-panel-24"].includes(config.automation.modeAssumption)
    ? config.automation.modeAssumption
    : "auto-panel-24";
  config.automation.turnOnAbove = clampInteger(config.automation.turnOnAbove, 12, 45, 27);
  config.automation.turnOffBelow = clampInteger(config.automation.turnOffBelow, 5, 40, 24);
  config.automation.turnOnBelow = clampInteger(config.automation.turnOnBelow, 0, 30, 17);
  config.automation.turnOffAbove = clampInteger(config.automation.turnOffAbove, 5, 35, 20);
  config.automation.coolingRule.enabled = Boolean(config.automation.coolingRule.enabled);
  config.automation.coolingRule.turnOnAbove = clampInteger(config.automation.coolingRule.turnOnAbove ?? config.automation.turnOnAbove, 12, 45, 25);
  config.automation.coolingRule.turnOffAtOrBelow = clampInteger(config.automation.coolingRule.turnOffAtOrBelow ?? config.automation.turnOffBelow, 5, 40, 21);
  config.automation.heatingRule.enabled = Boolean(config.automation.heatingRule.enabled);
  config.automation.heatingRule.turnOnBelow = clampInteger(config.automation.heatingRule.turnOnBelow ?? config.automation.turnOnBelow, 0, 30, 15);
  config.automation.heatingRule.turnOffAtOrAbove = clampInteger(config.automation.heatingRule.turnOffAtOrAbove ?? config.automation.turnOffAbove, 5, 35, 21);
  config.automation.minimumRunMinutes = clampInteger(config.automation.minimumRunMinutes, 1, 240, 20);
  config.automation.minimumRestMinutes = clampInteger(config.automation.minimumRestMinutes, 1, 240, 15);
  config.automation.evaluateOnRefresh = Boolean(config.automation.evaluateOnRefresh);
  config.automation.activeRule = ["cooling", "heating"].includes(config.automation.activeRule) ? config.automation.activeRule : null;
  config.integrations.ecowitt.enabled = Boolean(config.integrations.ecowitt.enabled);
  config.integrations.solarBattery.enabled = Boolean(config.integrations.solarBattery.enabled);
  return config;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function writeSmartConfig(value) {
  const config = normalizeSmartConfig(value);
  fs.writeFileSync(SMART_CONFIG_FILE, JSON.stringify(config, null, 2));
  broadcastNamedEvent("smart-config", config);
  return config;
}

function logEvent(type, details = {}) {
  const event = {
    at: new Date().toISOString(),
    type,
    details
  };
  fs.appendFileSync(EVENT_LOG_FILE, `${JSON.stringify(event)}\n`);
  broadcastNamedEvent("smart-event", event);
  return event;
}

function readEvents(limit = 60) {
  if (!fs.existsSync(EVENT_LOG_FILE)) return [];
  const lines = fs.readFileSync(EVENT_LOG_FILE, "utf8").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(200, Number(limit) || 60))).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { at: null, type: "invalid-log-entry", details: { line } };
    }
  }).reverse();
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 7000, headers: { "User-Agent": "AirTouchLocal/1.0" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Weather provider returned HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Weather provider returned invalid JSON"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Weather provider timed out")));
    request.on("error", reject);
  });
}

function weatherHint(pathname) {
  if (pathname === "/api/geocode") {
    return "Try a simpler location such as “Perth”, “Perth WA”, or use device location. Weather lookup uses Open-Meteo geocoding.";
  }
  if (pathname === "/api/weather") {
    return "Check that weather is enabled, a location is saved, and this server can reach Open-Meteo.";
  }
  return `Check that ${AIRCON_HOST} is reachable and AIRCON_USER/AIRCON_PASSWORD are correct.`;
}

function weatherCode(code) {
  const value = Number(code);
  if ([0].includes(value)) return { icon: "☀️", label: "Clear" };
  if ([1, 2].includes(value)) return { icon: "🌤️", label: "Partly cloudy" };
  if ([3].includes(value)) return { icon: "☁️", label: "Cloudy" };
  if ([45, 48].includes(value)) return { icon: "🌫️", label: "Fog" };
  if ([51, 53, 55, 56, 57].includes(value)) return { icon: "🌦️", label: "Drizzle" };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return { icon: "🌧️", label: "Rain" };
  if ([71, 73, 75, 77, 85, 86].includes(value)) return { icon: "🌨️", label: "Snow" };
  if ([95, 96, 99].includes(value)) return { icon: "⛈️", label: "Storm" };
  return { icon: "🌡️", label: "Weather" };
}

function googleWeatherUrl(location) {
  const label = location?.name || [location?.latitude, location?.longitude].filter((value) => value != null).join(",");
  return `https://www.google.com/search?q=${encodeURIComponent(`weather ${label || "near me"}`)}`;
}

function solarOutlook(hours) {
  const daylight = hours.filter((hour) => hour.isDay);
  if (!daylight.length) return { label: "Night", detail: "No solar generation expected in this window." };
  const averageCloud = Math.round(daylight.reduce((sum, hour) => sum + Number(hour.cloudCover ?? 0), 0) / daylight.length);
  const peakRadiation = Math.max(...daylight.map((hour) => Number(hour.shortwaveRadiation ?? 0)));
  if (averageCloud <= 25 && peakRadiation >= 550) return { label: "Strong solar window", detail: `${averageCloud}% avg cloud · peak ${Math.round(peakRadiation)} W/m²` };
  if (averageCloud <= 50 && peakRadiation >= 350) return { label: "Useful solar window", detail: `${averageCloud}% avg cloud · peak ${Math.round(peakRadiation)} W/m²` };
  if (averageCloud <= 75 || peakRadiation >= 180) return { label: "Patchy solar", detail: `${averageCloud}% avg cloud · peak ${Math.round(peakRadiation)} W/m²` };
  return { label: "Poor solar window", detail: `${averageCloud}% avg cloud · peak ${Math.round(peakRadiation)} W/m²` };
}

function locationQueryVariants(query) {
  const cleaned = String(query || "").trim().replace(/\s+/g, " ");
  const variants = [];
  const add = (value, options = {}) => {
    const name = String(value || "").trim();
    if (!name || variants.some((item) => item.name.toLowerCase() === name.toLowerCase() && item.countryCode === options.countryCode)) return;
    variants.push({ name, countryCode: options.countryCode || "" });
  };
  add(cleaned);

  const australian = /\b(australia|western australia|wa|new south wales|nsw|victoria|vic|queensland|qld|south australia|sa|tasmania|tas|northern territory|nt|act)\b/i.test(cleaned);
  if (australian) add(cleaned.replace(/\b(western australia|new south wales|victoria|queensland|south australia|tasmania|northern territory|australia|wa|nsw|vic|qld|sa|tas|nt|act)\b/ig, "").replace(/[,\s]+$/g, "").trim(), { countryCode: "AU" });

  const firstPart = cleaned.split(",")[0]?.trim();
  if (firstPart && firstPart !== cleaned) add(firstPart, australian ? { countryCode: "AU" } : {});
  if (/\s/.test(cleaned)) add(cleaned.split(/\s+/)[0], australian ? { countryCode: "AU" } : {});
  return variants;
}

async function readWeather(force = false) {
  const config = readSmartConfig();
  if (!config.weather.enabled) {
    return { enabled: false, configured: false, reason: "Weather is turned off." };
  }
  if (config.location.latitude == null || config.location.longitude == null) {
    return { enabled: false, configured: false, reason: "Weather is on, but needs a city or latitude/longitude." };
  }
  const refreshMs = config.weather.refreshMinutes * 60_000;
  if (!force && weatherCache && Date.now() - weatherCache.cachedAt < refreshMs) {
    return weatherCache.value;
  }
  const latitude = encodeURIComponent(config.location.latitude);
  const longitude = encodeURIComponent(config.location.longitude);
  const timezone = encodeURIComponent(config.location.timezone || "auto");
  const hourly = "temperature_2m,apparent_temperature,precipitation_probability,cloud_cover,shortwave_radiation,is_day,weather_code";
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,wind_speed_10m,cloud_cover&hourly=${hourly}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=${timezone}`;
  const data = await httpsJson(url);
  const currentCode = weatherCode(data.current?.weather_code);
  const now = Date.now();
  const hourlyForecast = (data.hourly?.time || [])
    .map((time, index) => ({
      time,
      temperature: data.hourly.temperature_2m?.[index] ?? null,
      apparentTemperature: data.hourly.apparent_temperature?.[index] ?? null,
      rainChance: data.hourly.precipitation_probability?.[index] ?? null,
      cloudCover: data.hourly.cloud_cover?.[index] ?? null,
      shortwaveRadiation: data.hourly.shortwave_radiation?.[index] ?? null,
      isDay: Boolean(data.hourly.is_day?.[index]),
      ...weatherCode(data.hourly.weather_code?.[index])
    }))
    .filter((hour) => Date.parse(hour.time) >= now - 60 * 60 * 1000)
    .slice(0, 12);
  const forecast = (data.daily?.time || []).map((date, index) => ({
    date,
    max: data.daily.temperature_2m_max?.[index] ?? null,
    min: data.daily.temperature_2m_min?.[index] ?? null,
    rainChance: data.daily.precipitation_probability_max?.[index] ?? null,
    ...weatherCode(data.daily.weather_code?.[index])
  }));
  const value = {
    enabled: true,
    provider: "open-meteo",
    location: config.location,
    current: {
      temperature: data.current?.temperature_2m ?? null,
      apparentTemperature: data.current?.apparent_temperature ?? null,
      humidity: data.current?.relative_humidity_2m ?? null,
      precipitation: data.current?.precipitation ?? null,
      rain: data.current?.rain ?? null,
      windSpeed: data.current?.wind_speed_10m ?? null,
      cloudCover: data.current?.cloud_cover ?? null,
      isDay: Boolean(data.current?.is_day),
      ...currentCode
    },
    hourly: hourlyForecast,
    solar: solarOutlook(hourlyForecast),
    forecast,
    googleWeatherUrl: googleWeatherUrl(config.location),
    fetchedAt: new Date().toISOString()
  };
  weatherCache = { cachedAt: Date.now(), value };
  return value;
}

async function geocodeLocation(name) {
  const query = String(name || "").trim();
  if (query.length < 2) throw new Error("Enter a city or suburb to search");
  let results = [];
  for (const variant of locationQueryVariants(query)) {
    const country = variant.countryCode ? `&countryCode=${encodeURIComponent(variant.countryCode)}` : "";
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(variant.name)}&count=8&language=en&format=json${country}`;
    const data = await httpsJson(url);
    results = (data.results || []).map((result) => ({
      name: [result.name, result.admin1, result.country].filter(Boolean).join(", "),
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: result.timezone || "auto"
    }));
    if (results.length) break;
  }
  if (!results.length) throw new Error(`No weather location matched “${query}”. Try “Perth” or “Perth WA”.`);
  return { results };
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

function minutesSince(iso) {
  if (!iso) return Infinity;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return Infinity;
  return (Date.now() - then) / 60_000;
}

function automationDecision(config, status) {
  if (!config.automation.enabled || !config.automation.evaluateOnRefresh) return null;
  if (status.temperature == null || status.error || !status.available) return null;

  const temperature = Number(status.temperature);
  const sinceLastAction = minutesSince(config.automation.lastActionAt);
  const cooling = config.automation.coolingRule;
  const heating = config.automation.heatingRule;

  if (status.on && sinceLastAction < config.automation.minimumRunMinutes) return null;
  if (!status.on && sinceLastAction < config.automation.minimumRestMinutes) return null;

  if (!status.on) {
    if (cooling.enabled && temperature >= cooling.turnOnAbove) {
      return {
        on: true,
        activeRule: "cooling",
        action: "turn-on-cooling",
        reason: `Indoor temperature is ${temperature}°C, at or above hot-rule start ${cooling.turnOnAbove}°C.`
      };
    }
    if (heating.enabled && temperature <= heating.turnOnBelow) {
      return {
        on: true,
        activeRule: "heating",
        action: "turn-on-heating",
        reason: `Indoor temperature is ${temperature}°C, at or below cold-rule start ${heating.turnOnBelow}°C.`
      };
    }
    return null;
  }

  if (config.automation.activeRule === "cooling" && cooling.enabled && temperature <= cooling.turnOffAtOrBelow) {
    return {
      on: false,
      activeRule: null,
      action: "turn-off-cooling",
      reason: `Hot-rule cycle is satisfied at ${temperature}°C, at or below ${cooling.turnOffAtOrBelow}°C.`
    };
  }
  if (config.automation.activeRule === "heating" && heating.enabled && temperature >= heating.turnOffAtOrAbove) {
    return {
      on: false,
      activeRule: null,
      action: "turn-off-heating",
      reason: `Cold-rule cycle is satisfied at ${temperature}°C, at or above ${heating.turnOffAtOrAbove}°C.`
    };
  }
  return null;
}

async function evaluateAutomation(status) {
  if (automationBusy) return status;
  const config = readSmartConfig();
  const decision = automationDecision(config, status);
  if (!decision) return status;

  automationBusy = true;
  try {
    logEvent("automation-decision", {
      action: decision.action,
      reason: decision.reason,
      activeRule: decision.activeRule,
      modeAssumption: config.automation.modeAssumption
    });
    await uartWrite(buildControlCommand(status, { on: decision.on }));
    await delay(350);
    const updated = await readStatus();
    const nextConfig = readSmartConfig();
    nextConfig.automation.lastActionAt = new Date().toISOString();
    nextConfig.automation.lastAction = decision.action;
    nextConfig.automation.activeRule = decision.activeRule;
    writeSmartConfig(nextConfig);
    logEvent("automation-action", {
      action: nextConfig.automation.lastAction,
      reason: decision.reason,
      temperature: status.temperature,
      activeRule: nextConfig.automation.activeRule
    });
    return updated;
  } finally {
    automationBusy = false;
  }
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
      const status = await exclusive(async () => evaluateAutomation(await readStatus()));
      json(response, 200, status);
      broadcastStatus(status);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      json(response, 200, {
        controllerHost: AIRCON_HOST,
        appAuthentication: appAuthorization ? "password" : "local-only",
        smartConfigStored: fs.existsSync(SMART_CONFIG_FILE),
        dataDir: DATA_DIR,
        clockSync: {
          supported: false,
          reason: "No independently verified clock-write command has been identified."
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/smart-config") {
      json(response, 200, readSmartConfig());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/smart-config") {
      const body = await readJson(request);
      const config = writeSmartConfig(mergeConfig(readSmartConfig(), body));
      weatherCache = null;
      logEvent("smart-config-updated", {
        weather: config.weather.enabled,
        automation: config.automation.enabled,
        notifications: config.notifications.enabled
      });
      json(response, 200, config);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/weather") {
      json(response, 200, await readWeather(url.searchParams.get("force") === "1"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/geocode") {
      json(response, 200, await geocodeLocation(url.searchParams.get("name")));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/events-log") {
      json(response, 200, { events: readEvents(url.searchParams.get("limit")) });
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
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    json(response, 502, {
      error: error.message,
      hint: weatherHint(url.pathname)
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AirTouch Local is ready at http://${HOST}:${PORT}`);
  console.log(`Controller: http://${AIRCON_HOST} (user: ${AIRCON_USER})`);
  console.log(`Backups: ${BACKUPS}`);
  console.log(`App authentication: ${appAuthorization ? "enabled" : "disabled"}`);
});
