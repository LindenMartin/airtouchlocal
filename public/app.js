"use strict";

const elements = {
  ambientClock: document.querySelector("#ambientClock"),
  backupButton: document.querySelector("#backupButton"),
  backupList: document.querySelector("#backupList"),
  climateCard: document.querySelector("#climateCard"),
  clockSyncNote: document.querySelector("#clockSyncNote"),
  configuredAuth: document.querySelector("#configuredAuth"),
  configuredHost: document.querySelector("#configuredHost"),
  connection: document.querySelector("#connection"),
  connectionText: document.querySelector("#connectionText"),
  controllerDateLong: document.querySelector("#controllerDateLong"),
  controllerTime: document.querySelector("#controllerTime"),
  deviceClock: document.querySelector("#deviceClock"),
  greeting: document.querySelector("#greeting"),
  googleWeatherLink: document.querySelector("#googleWeatherLink"),
  hourlyForecast: document.querySelector("#hourlyForecast"),
  hourlyWeatherCard: document.querySelector("#hourlyWeatherCard"),
  hourlyWeatherSummary: document.querySelector("#hourlyWeatherSummary"),
  solarWattageChart: document.querySelector("#solarWattageChart"),
  solarWattagePlot: document.querySelector("#solarWattagePlot"),
  automationEnabled: document.querySelector("#automationEnabled"),
  automationStatus: document.querySelector("#automationStatus"),
  eventList: document.querySelector("#eventList"),
  coolingRuleEnabled: document.querySelector("#coolingRuleEnabled"),
  findLocationButton: document.querySelector("#findLocationButton"),
  heatingRuleEnabled: document.querySelector("#heatingRuleEnabled"),
  latitude: document.querySelector("#latitude"),
  locationName: document.querySelector("#locationName"),
  liveSyncStatus: document.querySelector("#liveSyncStatus"),
  longitude: document.querySelector("#longitude"),
  minimumRestMinutes: document.querySelector("#minimumRestMinutes"),
  minimumRunMinutes: document.querySelector("#minimumRunMinutes"),
  modeAssumption: document.querySelector("#modeAssumption"),
  notifyAutomation: document.querySelector("#notifyAutomation"),
  notifyOffline: document.querySelector("#notifyOffline"),
  notifySpill: document.querySelector("#notifySpill"),
  notifyTemperature: document.querySelector("#notifyTemperature"),
  notificationsEnabled: document.querySelector("#notificationsEnabled"),
  outsideTemp: document.querySelector("#outsideTemp"),
  powerButton: document.querySelector("#powerButton"),
  powerLabel: document.querySelector("#powerLabel"),
  packetHealth: document.querySelector("#packetHealth"),
  protocolMap: document.querySelector("#protocolMap"),
  rawPacket: document.querySelector("#rawPacket"),
  refreshButton: document.querySelector("#refreshButton"),
  refreshInterval: document.querySelector("#refreshInterval"),
  requestNotificationsButton: document.querySelector("#requestNotificationsButton"),
  saveAutomationButton: document.querySelector("#saveAutomationButton"),
  saveWeatherButton: document.querySelector("#saveWeatherButton"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsCloseButton: document.querySelector("#settingsCloseButton"),
  settingsConnection: document.querySelector("#settingsConnection"),
  settingsControllerClock: document.querySelector("#settingsControllerClock"),
  settingsDialog: document.querySelector("#settingsDialog"),
  summary: document.querySelector("#summary"),
  systemNote: document.querySelector("#systemNote"),
  systemState: document.querySelector("#systemState"),
  temperatureValue: document.querySelector("#temperatureValue"),
  temperatureFeeling: document.querySelector("#temperatureFeeling"),
  testNotificationButton: document.querySelector("#testNotificationButton"),
  timerSummary: document.querySelector("#timerSummary"),
  turnOffAbove: document.querySelector("#turnOffAbove"),
  turnOffBelow: document.querySelector("#turnOffBelow"),
  turnOnAbove: document.querySelector("#turnOnAbove"),
  turnOnBelow: document.querySelector("#turnOnBelow"),
  useDeviceLocationButton: document.querySelector("#useDeviceLocationButton"),
  toast: document.querySelector("#toast"),
  weatherCard: document.querySelector("#weatherCard"),
  weatherEnabled: document.querySelector("#weatherEnabled"),
  weatherForecast: document.querySelector("#weatherForecast"),
  weatherIcon: document.querySelector("#weatherIcon"),
  weatherRefresh: document.querySelector("#weatherRefresh"),
  weatherStatus: document.querySelector("#weatherStatus"),
  weatherSummary: document.querySelector("#weatherSummary"),
  solarOutlook: document.querySelector("#solarOutlook"),
  zoneCount: document.querySelector("#zoneCount"),
  zonesGrid: document.querySelector("#zonesGrid")
};

let state = null;
let requestInFlight = false;
let updating = false;
let toastTimeout;
let refreshTimer;
let pendingLiveState = null;
let smartConfig = null;
let weather = null;
let notifiedState = { spill: false, hot: false, cold: false };
const REFRESH_INTERVAL_KEY = "airtouch-refresh-seconds";
const REFRESH_INTERVALS = [5, 10, 15, 30, 60];

function storedRefreshSeconds() {
  const stored = Number(localStorage.getItem(REFRESH_INTERVAL_KEY));
  return REFRESH_INTERVALS.includes(stored) ? stored : 15;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[character]));
}

function greetingFor(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function formatClock(clock) {
  if (!clock) return "—";
  const suffix = clock.hour >= 12 ? "PM" : "AM";
  const hour = clock.hour % 12 || 12;
  return `${hour}:${String(clock.minute).padStart(2, "0")} ${suffix}`;
}

function formatControllerDate(date) {
  if (!date) return "—";
  return `${String(date.day).padStart(2, "0")}/${String(date.month).padStart(2, "0")}/${date.year}`;
}

function formatLongDate(date) {
  if (!date) return "Waiting for controller";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long", day: "numeric", month: "long"
  }).format(new Date(date.year, date.month - 1, date.day));
}

function formatDeviceClock(date = new Date()) {
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit"
  }).format(date);
}

function temperatureFeeling(value) {
  if (value == null) return "Inside now";
  if (value <= 15) return "Cold inside";
  if (value <= 19) return "Cool inside";
  if (value <= 24) return "Comfortable";
  if (value <= 28) return "Warm inside";
  return "Hot inside";
}

function applyTemperatureTheme(value) {
  if (value == null) {
    elements.climateCard.style.removeProperty("--temp-hue");
    return;
  }
  elements.climateCard.style.setProperty("--temp-hue", String(temperatureHue(value)));
}

function temperatureHue(value) {
  // 0–45°C perceptual scale: deep blue cold, green comfort around 20°C, red hot.
  const stops = [
    { temp: 0, hue: 225 },
    { temp: 10, hue: 198 },
    { temp: 20, hue: 145 },
    { temp: 30, hue: 42 },
    { temp: 45, hue: 4 }
  ];
  const clamped = Math.max(stops[0].temp, Math.min(stops.at(-1).temp, Number(value)));
  const upper = stops.find((stop) => clamped <= stop.temp) || stops.at(-1);
  const lower = stops[Math.max(0, stops.indexOf(upper) - 1)];
  if (upper === lower) return upper.hue;
  const ratio = (clamped - lower.temp) / (upper.temp - lower.temp);
  return Math.round(lower.hue + (upper.hue - lower.hue) * ratio);
}

function formatTemperature(value) {
  return value == null ? "—" : Math.round(Number(value));
}

function temperatureStyle(value) {
  return `--temp-hue: ${temperatureHue(value ?? 20)}`;
}

function formatHour(value) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
}

function notificationAllowed() {
  return smartConfig?.notifications?.enabled && "Notification" in window && Notification.permission === "granted";
}

function sendBrowserNotification(title, body) {
  try {
    new Notification(title, {
      body,
      tag: `airtouch-${title.toLowerCase().replace(/\W+/g, "-")}`,
      icon: "/favicon.ico"
    });
  } catch {
    // Some browsers expose Notification but still refuse it outside secure contexts.
  }
}

function notify(title, body) {
  if (!notificationAllowed()) return;
  sendBrowserNotification(title, body);
}

function maybeNotify(previous) {
  if (!state || !smartConfig?.notifications) return;
  const spillZone = state.groups.find((group) => group.spill);
  if (smartConfig.notifications.spill && spillZone && !notifiedState.spill) {
    notify("AirTouch spill active", `${spillZone.name} is in spill at ${spillZone.openPercent}%.`);
  }
  notifiedState.spill = Boolean(spillZone);

  const hot = state.temperature != null && state.temperature >= smartConfig.notifications.indoorHotAt;
  const cold = state.temperature != null && state.temperature <= smartConfig.notifications.indoorColdAt;
  if (smartConfig.notifications.temperatureThresholds && hot && !notifiedState.hot) notify("Home is getting warm", `Inside is ${state.temperature}°C.`);
  if (smartConfig.notifications.temperatureThresholds && cold && !notifiedState.cold) notify("Home is getting cold", `Inside is ${state.temperature}°C.`);
  notifiedState.hot = hot;
  notifiedState.cold = cold;

  if (previous?.on !== undefined && previous.on !== state.on && smartConfig.notifications.automationActions) {
    notify("AirTouch power changed", `System is now ${state.on ? "running" : "standby"}.`);
  }
}

function renderWeather() {
  if (!weather?.enabled) {
    setText(elements.outsideTemp, "—", false);
    setText(elements.weatherIcon, "🌤️", false);
    elements.weatherSummary.textContent = weather?.reason || "Add your location for forecast-aware comfort.";
    elements.weatherForecast.innerHTML = `<div><strong>Weather</strong><span>${escapeHtml(weather?.reason || "Not configured")}</span></div>`;
    elements.solarOutlook.innerHTML = "<strong>Solar outlook</strong><span>Waiting for cloud forecast</span>";
    elements.hourlyForecast.innerHTML = '<div class="hourly-empty">Enable weather to see cloud cover and solar radiation.</div>';
    setText(elements.hourlyWeatherSummary, "Cloud cover drives solar generation.", false);
    elements.googleWeatherLink.href = "https://www.google.com/search?q=weather";
    elements.weatherCard.classList.remove("ready");
    elements.hourlyWeatherCard.classList.remove("ready");
    renderSolarWattageChart([]);
    return;
  }
  elements.weatherCard.classList.add("ready");
  elements.hourlyWeatherCard.classList.add("ready");
  elements.weatherCard.style.setProperty("--temp-hue", String(temperatureHue(weather.current.temperature ?? 20)));
  setText(elements.outsideTemp, formatTemperature(weather.current.temperature), true);
  setText(elements.weatherIcon, weather.current.icon || "🌡️", true);
  elements.weatherSummary.innerHTML = `${escapeHtml(weather.current.label)} · ${weather.current.cloudCover ?? "—"}% cloud · feels <span class="temp-inline" style="${temperatureStyle(weather.current.apparentTemperature)}">${formatTemperature(weather.current.apparentTemperature)}°C</span>`;
  elements.googleWeatherLink.href = weather.googleWeatherUrl || "https://www.google.com/search?q=weather";
  elements.solarOutlook.innerHTML = `<strong>${escapeHtml(weather.solar?.label || "Solar outlook")}</strong><span>${escapeHtml(weather.solar?.detail || "Waiting for cloud forecast")}</span>`;
  setText(elements.hourlyWeatherSummary, weather.solar?.detail || "Cloud cover drives solar generation.", true);
  elements.weatherForecast.innerHTML = weather.forecast.slice(0, 3).map((day) => {
    const label = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
    return `<div>
      <strong>${escapeHtml(label)} ${escapeHtml(day.icon)}</strong>
      <span><span class="temp-inline" style="${temperatureStyle(day.min)}">${formatTemperature(day.min)}°</span>–<span class="temp-inline" style="${temperatureStyle(day.max)}">${formatTemperature(day.max)}°C</span> · ${day.rainChance ?? "—"}% rain</span>
    </div>`;
  }).join("");
  const hours = (weather.hourly || []).slice(0, 12);
  elements.hourlyForecast.innerHTML = hours.length ? hours.map((hour) => {
    const watts = hour.effectiveWatts ?? (hour.isDay ? hour.shortwaveRadiation : 0);
    return `
    <article class="hour-card${hour.isDay ? " day" : " night"}" style="${temperatureStyle(hour.temperature)}">
      <strong>${escapeHtml(formatHour(hour.time))}</strong>
      <span class="hour-icon">${escapeHtml(hour.icon)}</span>
      <span class="hour-temp">${formatTemperature(hour.temperature)}°C</span>
      <small>${hour.cloudCover ?? "—"}% cloud</small>
      <small>${watts == null ? "—" : `${Math.round(watts)} W/m²`}</small>
    </article>`;
  }).join("") : '<div class="hourly-empty">No hourly forecast returned yet.</div>';
  renderSolarWattageChart(hours);
}

function renderSolarWattageChart(hours) {
  if (!elements.solarWattageChart || !elements.solarWattagePlot) return;
  if (!hours.length) {
    elements.solarWattageChart.hidden = true;
    elements.solarWattagePlot.innerHTML = "";
    return;
  }
  const values = hours.map((hour) => {
    const watts = hour.effectiveWatts ?? (hour.isDay ? Number(hour.shortwaveRadiation ?? 0) : 0);
    return Number.isFinite(watts) ? Math.max(0, watts) : 0;
  });
  const peak = Math.max(200, ...values);
  const width = 600;
  const height = 148;
  const pad = { top: 16, right: 12, bottom: 28, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const gap = 6;
  const barW = Math.max(8, (plotW - gap * (hours.length - 1)) / hours.length);
  const ticks = [0, Math.round(peak / 2), Math.round(peak)];
  const bars = hours.map((hour, index) => {
    const watts = values[index];
    const cloud = Math.min(100, Math.max(0, Number(hour.cloudCover ?? 0)));
    const barH = peak ? (watts / peak) * plotH : 0;
    const x = pad.left + index * (barW + gap);
    const y = pad.top + plotH - barH;
    // Cloud darkens the fill: clear sky stays bright amber, heavy cloud is cooler/dimmer.
    const clearFraction = 1 - cloud / 100;
    const fill = hour.isDay
      ? `rgba(255, ${Math.round(160 + 40 * clearFraction)}, ${Math.round(80 + 40 * clearFraction)}, ${0.35 + 0.5 * clearFraction})`
      : "rgba(105,184,255,.18)";
    const labelY = height - 8;
    return `
      <rect class="watt-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(barH, watts > 0 ? 2 : 0).toFixed(1)}" rx="4" fill="${fill}">
        <title>${escapeHtml(formatHour(hour.time))}: ${Math.round(watts)} W/m² · ${hour.cloudCover ?? "—"}% cloud</title>
      </rect>
      <text class="watt-hour" x="${(x + barW / 2).toFixed(1)}" y="${labelY}" text-anchor="middle">${escapeHtml(formatHour(hour.time))}</text>`;
  }).join("");
  const grid = ticks.map((tick) => {
    const y = pad.top + plotH - (tick / peak) * plotH;
    return `
      <line class="watt-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" />
      <text class="watt-axis" x="${pad.left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${tick}</text>`;
  }).join("");
  // Cloud cover polyline (0–100% mapped onto the same plot height for context).
  const cloudPoints = hours.map((hour, index) => {
    const cloud = Math.min(100, Math.max(0, Number(hour.cloudCover ?? 0)));
    const x = pad.left + index * (barW + gap) + barW / 2;
    const y = pad.top + plotH - (cloud / 100) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  elements.solarWattageChart.hidden = false;
  elements.solarWattagePlot.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      ${grid}
      ${bars}
      <polyline class="cloud-line" fill="none" points="${cloudPoints}"></polyline>
    </svg>
    <div class="solar-wattage-legend">
      <span class="legend-watts">Wattage (W/m²)</span>
      <span class="legend-cloud">Cloud cover %</span>
    </div>`;
}

function populateSmartConfig() {
  if (!smartConfig) return;
  elements.locationName.value = smartConfig.location.name || "";
  elements.latitude.value = smartConfig.location.latitude ?? "";
  elements.longitude.value = smartConfig.location.longitude ?? "";
  elements.weatherEnabled.checked = Boolean(smartConfig.weather.enabled);
  elements.weatherRefresh.value = String(smartConfig.weather.refreshMinutes);
  elements.weatherStatus.textContent = weatherStatusText(smartConfig);
  elements.automationEnabled.checked = Boolean(smartConfig.automation.enabled);
  elements.modeAssumption.value = smartConfig.automation.modeAssumption;
  elements.coolingRuleEnabled.checked = Boolean(smartConfig.automation.coolingRule?.enabled);
  elements.heatingRuleEnabled.checked = Boolean(smartConfig.automation.heatingRule?.enabled);
  elements.turnOnAbove.value = smartConfig.automation.coolingRule?.turnOnAbove ?? smartConfig.automation.turnOnAbove;
  elements.turnOffBelow.value = smartConfig.automation.coolingRule?.turnOffAtOrBelow ?? smartConfig.automation.turnOffBelow;
  elements.turnOnBelow.value = smartConfig.automation.heatingRule?.turnOnBelow ?? smartConfig.automation.turnOnBelow;
  elements.turnOffAbove.value = smartConfig.automation.heatingRule?.turnOffAtOrAbove ?? smartConfig.automation.turnOffAbove;
  elements.minimumRunMinutes.value = smartConfig.automation.minimumRunMinutes;
  elements.minimumRestMinutes.value = smartConfig.automation.minimumRestMinutes;
  elements.notificationsEnabled.checked = Boolean(smartConfig.notifications.enabled);
  elements.notifySpill.checked = Boolean(smartConfig.notifications.spill);
  elements.notifyTemperature.checked = Boolean(smartConfig.notifications.temperatureThresholds);
  elements.notifyAutomation.checked = Boolean(smartConfig.notifications.automationActions);
  elements.notifyOffline.checked = Boolean(smartConfig.notifications.controllerOffline);
  elements.automationStatus.textContent = smartConfig.automation.enabled ? "Armed" : "Off";
}

function weatherStatusText(config) {
  if (!config?.weather?.enabled) return "Off";
  if (config.location?.latitude == null || config.location?.longitude == null) return "Needs location";
  return "On";
}

function formatTimer(timer) {
  return timer?.enabled ? formatClock(timer) : null;
}

function showToast(message, error = false) {
  clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${error ? " error" : ""}`;
  toastTimeout = setTimeout(() => { elements.toast.className = "toast"; }, 3500);
}

function setConnection(mode, label) {
  elements.connection.className = `connection ${mode}`;
  elements.connectionText.textContent = label;
}

function animateChange(element) {
  element.classList.remove("value-changed");
  requestAnimationFrame(() => {
    element.classList.add("value-changed");
    setTimeout(() => element.classList.remove("value-changed"), 650);
  });
}

function setText(element, value, animate) {
  const next = String(value);
  if (element.textContent === next) return;
  element.textContent = next;
  if (animate) animateChange(element);
}

function zoneDescription(group) {
  if (group.spill) return "Spill";
  if (group.turbo) return "Turbo airflow";
  return group.on ? "Airflow on" : "Airflow off";
}

function zoneMarkup(group) {
  const airflowDisabled = updating || !state.on || !group.on || group.spill || group.turbo;
  return `
    <article class="zone-card${group.on ? " active" : ""}${group.spill ? " spilling" : ""}" data-zone-id="${group.id}">
      ${group.spill ? `<div class="spill-alert" role="status">
        <span class="spill-alert-dot" aria-hidden="true"></span>
        <strong>Spill</strong>
      </div>` : ""}
      <div class="zone-top">
        <span class="zone-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8c4 0 4-3 8-3 2.2 0 3.7.8 5 2M4 12c5 0 5-2 9-2 2.4 0 4 .8 5.5 2M4 16c4 0 5 3 9 3 2.2 0 3.7-.8 5-2"/></svg>
        </span>
        <button class="zone-toggle" data-zone-toggle="${group.id}" aria-label="Toggle ${escapeHtml(group.name)}" aria-pressed="${group.on}" ${updating || !state.on ? "disabled" : ""}>
          <span class="zone-toggle-label">${group.on ? "On" : "Off"}</span>
          <span class="switch" aria-hidden="true"></span>
        </button>
      </div>
      <h3>${escapeHtml(group.name)}</h3>
      <p class="zone-status">${zoneDescription(group)}</p>
      <div class="airflow-control">
        <label for="airflow-${group.id}"><span>${group.spill ? "Safety opening" : "Opening"}</span><strong class="airflow-value">${group.openPercent}%</strong></label>
        <input id="airflow-${group.id}" class="airflow-slider" data-zone-airflow="${group.id}" type="range" min="10" max="100" step="10" value="${group.openPercent}" ${airflowDisabled ? "disabled" : ""}>
        <div class="range-scale"><span>10%</span><span>100%</span></div>
      </div>
    </article>
  `;
}

function renderZones(previous) {
  const cards = Array.from(elements.zonesGrid.querySelectorAll(".zone-card"));
  const canReuse = cards.length === state.groups.length && cards.every((card, index) =>
    Number(card.dataset.zoneId) === state.groups[index].id &&
    card.querySelector("h3")?.textContent === state.groups[index].name
  );

  if (!canReuse) {
    elements.zonesGrid.innerHTML = state.groups.map(zoneMarkup).join("");
    return;
  }

  cards.forEach((card, index) => {
    const group = state.groups[index];
    const oldGroup = previous?.groups.find((item) => item.id === group.id);
    const changed = oldGroup && (oldGroup.on !== group.on || oldGroup.turbo !== group.turbo || oldGroup.openPercent !== group.openPercent);
    const toggle = card.querySelector("[data-zone-toggle]");
    const slider = card.querySelector("[data-zone-airflow]");
    card.classList.toggle("active", group.on);
    const wasSpilling = card.classList.contains("spilling");
    card.classList.toggle("spilling", group.spill);
    if (wasSpilling !== group.spill) {
      card.outerHTML = zoneMarkup(group);
      return;
    }
    toggle.setAttribute("aria-pressed", String(group.on));
    toggle.disabled = updating || !state.on;
    setText(toggle.querySelector(".zone-toggle-label"), group.on ? "On" : "Off", false);
    slider.disabled = updating || !state.on || !group.on || group.spill || group.turbo;
    slider.value = group.openPercent;
    setText(card.querySelector(".zone-status"), zoneDescription(group), false);
    setText(card.querySelector(".airflow-value"), `${group.openPercent}%`, changed);
    if (changed) animateChange(card);
  });
}

function renderProtocol() {
  const protocol = state.protocol;
  if (!protocol) return;
  setText(elements.packetHealth, `${protocol.length} bytes · checksum ${protocol.checksumValid ? "valid" : "invalid"}`, false);
  elements.packetHealth.classList.toggle("invalid", !protocol.checksumValid);
  elements.rawPacket.textContent = protocol.raw;
  elements.protocolMap.innerHTML = protocol.fields.map((field) => {
    const range = field.start === field.end ? field.start : `${field.start}–${field.end}`;
    const compactHex = field.hex.length > 48 ? `${field.hex.slice(0, 24)}…${field.hex.slice(-16)}` : field.hex;
    return `<div class="protocol-row ${field.confidence}">
      <span class="byte-range">${range}</span>
      <span class="field-name">${escapeHtml(field.name)}</span>
      <code class="field-type">${escapeHtml(field.type)}</code>
      <span class="field-confidence">${escapeHtml(field.confidence)}</span>
      <span class="field-value">${escapeHtml(field.value)}</span>
      <code class="field-hex" title="${field.hex}">${compactHex}</code>
    </div>`;
  }).join("");
}

function render(previous = null) {
  if (!state) return;
  const spillZone = state.groups.find((group) => group.spill);
  const activeZones = state.groups.filter((group) => group.on && !group.spill).length;
  const isOn = state.on;
  const animate = Boolean(previous);

  const controllerHour = state.controllerTime?.hour ?? new Date().getHours();
  setText(elements.greeting, `${greetingFor(controllerHour)}, ${state.owner.replace(/'s$/i, "")}`, animate);
  setText(elements.summary, spillZone
    ? `Spill · ${spillZone.name} at ${spillZone.openPercent}%`
    : isOn
      ? `${activeZones} of ${state.groups.length} zones are receiving air`
      : "Your system is resting", animate);
  elements.climateCard.classList.toggle("on", isOn);
  setText(elements.systemState, state.error ? "Needs attention" : isOn ? "Running" : "Standby", animate);
  setText(elements.systemNote, state.error
    ? "Controller reported an AC fault"
    : spillZone
      ? "Protective airflow is active"
      : isOn
        ? "Conditioning your active zones"
        : "Ready when you are", animate);
  setText(elements.temperatureValue, state.temperature ?? "—", animate);
  setText(elements.temperatureFeeling, temperatureFeeling(state.temperature), animate);
  applyTemperatureTheme(state.temperature);
  elements.powerButton.setAttribute("aria-pressed", String(isOn));
  setText(elements.powerLabel, isOn ? "Turn off" : "Turn on", animate);
  setText(elements.zoneCount, spillZone ? `Spill · ${spillZone.openPercent}%` : `${activeZones} active`, animate);
  setText(elements.controllerTime, formatClock(state.controllerTime), animate);
  setText(elements.controllerDateLong, formatLongDate(state.controllerDate), animate);
  setText(elements.settingsControllerClock, `${formatControllerDate(state.controllerDate)} · ${formatClock(state.controllerTime)}`, animate);
  elements.ambientClock.classList.toggle("night", controllerHour < 6 || controllerHour >= 18);
  elements.ambientClock.classList.toggle("day", controllerHour >= 6 && controllerHour < 18);

  const onTimer = formatTimer(state.timers?.on);
  const offTimer = formatTimer(state.timers?.off);
  setText(elements.timerSummary, [onTimer && `On ${onTimer}`, offTimer && `Off ${offTimer}`].filter(Boolean).join(" · ") || "None set", animate);

  renderZones(previous);
  renderProtocol();
  maybeNotify(previous);
  elements.powerButton.disabled = updating || state.error || !state.available;
}

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Controller request failed");
  return body;
}

async function refresh(quiet = false) {
  if (requestInFlight) return;
  requestInFlight = true;
  elements.refreshButton.classList.add("spinning");
  elements.refreshButton.setAttribute("aria-busy", "true");
  if (!state) setConnection("", "Connecting");
  try {
    const previous = state;
    state = await api("/api/status");
    setConnection("online", "Controller online");
    render(previous);
    if (!quiet) showToast("Status refreshed");
  } catch (error) {
    setConnection("offline", "Controller offline");
    if (!state) {
      elements.summary.textContent = "Could not reach the aircon controller";
      elements.zonesGrid.innerHTML = "";
    }
    showToast(error.message, true);
  } finally {
    requestInFlight = false;
    elements.refreshButton.classList.remove("spinning");
    elements.refreshButton.removeAttribute("aria-busy");
    applyPendingLiveState();
  }
}

function applyLiveState(nextState) {
  if (requestInFlight || updating) {
    pendingLiveState = nextState;
    return;
  }
  const previous = state;
  state = nextState;
  setConnection("online", "Controller online");
  render(previous);
}

function applyPendingLiveState() {
  if (!pendingLiveState || requestInFlight || updating) return;
  const nextState = pendingLiveState;
  pendingLiveState = null;
  applyLiveState(nextState);
}

function setRefreshInterval(seconds, announce = false) {
  const interval = REFRESH_INTERVALS.includes(Number(seconds)) ? Number(seconds) : 15;
  localStorage.setItem(REFRESH_INTERVAL_KEY, String(interval));
  elements.refreshInterval.value = String(interval);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden && !requestInFlight) refresh(true);
  }, interval * 1000);
  if (announce) showToast(`Background refresh set to ${interval === 60 ? "1 minute" : `${interval} seconds`}`);
}

function connectLiveUpdates() {
  if (!("EventSource" in window)) {
    elements.liveSyncStatus.textContent = "Polling only";
    return;
  }
  const events = new EventSource("/api/events");
  events.addEventListener("open", () => {
    elements.liveSyncStatus.textContent = "Live sync on";
  });
  events.addEventListener("error", () => {
    elements.liveSyncStatus.textContent = "Reconnecting…";
  });
  events.addEventListener("status", (event) => {
    try {
      applyLiveState(JSON.parse(event.data));
    } catch {
      // Ignore an incomplete event; EventSource will continue with the next update.
    }
  });
  events.addEventListener("smart-config", (event) => {
    try {
      smartConfig = JSON.parse(event.data);
      populateSmartConfig();
    } catch {
      // Ignore malformed live settings.
    }
  });
  events.addEventListener("smart-event", () => {
    if (elements.settingsDialog.open) loadEvents();
  });
}

async function update(next) {
  if (!state || requestInFlight) return;
  const previous = structuredClone(state);
  state = { ...state, ...next };
  requestInFlight = true;
  updating = true;
  render(previous);
  try {
    const optimistic = state;
    state = await api("/api/control", {
      method: "POST",
      body: JSON.stringify({
        on: state.on,
        groups: Object.fromEntries(state.groups.map((group) => [group.id, group.on]))
      })
    });
    setConnection("online", "Controller online");
    render(optimistic);
    showToast("Aircon updated");
  } catch (error) {
    const failed = state;
    state = previous;
    setConnection("offline", "Update failed");
    render(failed);
    showToast(error.message, true);
  } finally {
    requestInFlight = false;
    updating = false;
    render();
    applyPendingLiveState();
  }
}

async function updateAirflow(groupId, percent) {
  if (!state || requestInFlight) return;
  const previous = structuredClone(state);
  state = {
    ...state,
    groups: state.groups.map((group) => group.id === groupId
      ? { ...group, openStep: percent / 10, openPercent: percent }
      : group)
  };
  requestInFlight = true;
  updating = true;
  render(previous);
  try {
    const optimistic = state;
    state = await api("/api/airflow", {
      method: "POST",
      body: JSON.stringify({ groupId, percent })
    });
    setConnection("online", "Controller online");
    render(optimistic);
    showToast(`Airflow set to ${percent}%`);
  } catch (error) {
    const failed = state;
    state = previous;
    setConnection("offline", "Update failed");
    render(failed);
    showToast(error.message, true);
  } finally {
    requestInFlight = false;
    updating = false;
    render();
    applyPendingLiveState();
  }
}

function backupMarkup(backup) {
  if (backup.invalid) {
    return `<article class="backup-item invalid"><div><strong>${escapeHtml(backup.id)}</strong><span>${escapeHtml(backup.error)}</span></div></article>`;
  }
  const groups = backup.state.groups.map((group) =>
    `${escapeHtml(group.name)} ${group.on ? "on" : "off"} · ${group.openPercent}%`
  ).join(" · ");
  return `<article class="backup-item${backup.golden ? " golden" : ""}">
    <div class="backup-main">
      <div class="backup-title">
        <strong>${escapeHtml(backup.label)}</strong>
        ${backup.golden ? '<span class="golden-badge">Original state</span>' : ""}
      </div>
      <span>${new Date(backup.capturedAt).toLocaleString()}</span>
      <small>${groups}</small>
    </div>
    <div class="backup-actions">
      <a class="text-button" href="/api/backups/${encodeURIComponent(backup.id)}">Download</a>
      <button class="secondary-button" data-restore-backup="${escapeHtml(backup.id)}" data-backup-label="${escapeHtml(backup.label)}">Restore</button>
    </div>
  </article>`;
}

async function loadBackups() {
  try {
    const result = await api("/api/backups");
    elements.backupList.innerHTML = result.backups.length
      ? result.backups.map(backupMarkup).join("")
      : '<p class="empty-state">No snapshots yet.</p>';
  } catch (error) {
    elements.backupList.innerHTML = `<p class="empty-state error-text">${escapeHtml(error.message)}</p>`;
  }
}

async function loadSettings() {
  elements.deviceClock.textContent = formatDeviceClock();
  try {
    const config = await api("/api/config");
    elements.configuredHost.textContent = config.controllerHost;
    elements.configuredAuth.textContent = config.appAuthentication === "password" ? "Password enabled" : "Local network only";
    elements.settingsConnection.textContent = "Configured";
    elements.clockSyncNote.textContent = config.clockSync.reason;
  } catch (error) {
    elements.settingsConnection.textContent = "Unavailable";
  }
  await loadSmartConfig();
  await loadBackups();
  await loadEvents();
}

async function loadSmartConfig() {
  try {
    smartConfig = await api("/api/smart-config");
    populateSmartConfig();
  } catch (error) {
    elements.automationStatus.textContent = "Unavailable";
    elements.weatherStatus.textContent = "Unavailable";
  }
}

async function loadWeather(force = false) {
  try {
    weather = await api(`/api/weather${force ? "?force=1" : ""}`);
    renderWeather();
  } catch (error) {
    weather = { enabled: false, reason: error.message };
    renderWeather();
  }
}

function eventMarkup(event) {
  const when = event.at ? new Date(event.at).toLocaleString() : "Unknown time";
  const details = Object.entries(event.details || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
  return `<article class="event-item">
    <strong>${escapeHtml(event.type.replace(/-/g, " "))}</strong>
    <span>${escapeHtml(when)}</span>
    ${details ? `<small>${escapeHtml(details)}</small>` : ""}
  </article>`;
}

async function loadEvents() {
  try {
    const result = await api("/api/events-log?limit=50");
    elements.eventList.innerHTML = result.events.length
      ? result.events.map(eventMarkup).join("")
      : '<p class="empty-state">No smart events yet.</p>';
  } catch (error) {
    elements.eventList.innerHTML = `<p class="empty-state error-text">${escapeHtml(error.message)}</p>`;
  }
}

async function saveSmartConfig(patch, successMessage) {
  try {
    smartConfig = await api("/api/smart-config", {
      method: "POST",
      body: JSON.stringify(patch)
    });
    populateSmartConfig();
    await loadWeather(true);
    await loadEvents();
    showToast(successMessage);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function geocodeTypedLocation() {
  const name = elements.locationName.value.trim();
  if (!name) throw new Error("Enter a city/suburb or use device location");
  const result = await api(`/api/geocode?name=${encodeURIComponent(name)}`);
  const location = result.results?.[0];
  if (!location) throw new Error(`No weather location matched “${name}”`);
  elements.locationName.value = location.name;
  elements.latitude.value = Number(location.latitude).toFixed(6);
  elements.longitude.value = Number(location.longitude).toFixed(6);
  showToast(`Found ${location.name}`);
  return location;
}

async function saveWeatherFromForm() {
  if (elements.weatherEnabled.checked && (elements.latitude.value === "" || elements.longitude.value === "")) {
    await geocodeTypedLocation();
  }
  await saveSmartConfig(readWeatherForm(), "Weather settings saved");
}

function readWeatherForm() {
  return {
    location: {
      name: elements.locationName.value.trim(),
      latitude: elements.latitude.value === "" ? null : Number(elements.latitude.value),
      longitude: elements.longitude.value === "" ? null : Number(elements.longitude.value),
      timezone: "auto"
    },
    weather: {
      enabled: elements.weatherEnabled.checked,
      refreshMinutes: Number(elements.weatherRefresh.value)
    }
  };
}

function readAutomationForm() {
  return {
    notifications: {
      enabled: elements.notificationsEnabled.checked,
      temperatureThresholds: elements.notifyTemperature.checked,
      indoorHotAt: Number(elements.turnOnAbove.value || 28),
      indoorColdAt: Number(elements.turnOnBelow.value || 16),
      spill: elements.notifySpill.checked,
      automationActions: elements.notifyAutomation.checked,
      controllerOffline: elements.notifyOffline.checked
    },
    automation: {
      enabled: elements.automationEnabled.checked,
      modeAssumption: elements.modeAssumption.value,
      coolingRule: {
        enabled: elements.coolingRuleEnabled.checked,
        turnOnAbove: Number(elements.turnOnAbove.value),
        turnOffAtOrBelow: Number(elements.turnOffBelow.value)
      },
      heatingRule: {
        enabled: elements.heatingRuleEnabled.checked,
        turnOnBelow: Number(elements.turnOnBelow.value),
        turnOffAtOrAbove: Number(elements.turnOffAbove.value)
      },
      turnOnAbove: Number(elements.turnOnAbove.value),
      turnOffBelow: Number(elements.turnOffBelow.value),
      turnOnBelow: Number(elements.turnOnBelow.value),
      turnOffAbove: Number(elements.turnOffAbove.value),
      minimumRunMinutes: Number(elements.minimumRunMinutes.value),
      minimumRestMinutes: Number(elements.minimumRestMinutes.value),
      evaluateOnRefresh: true
    }
  };
}

async function useDeviceLocation() {
  if (!navigator.geolocation) {
    showToast("This browser does not expose device location", true);
    return;
  }
  elements.useDeviceLocationButton.disabled = true;
  elements.useDeviceLocationButton.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition((position) => {
    elements.latitude.value = position.coords.latitude.toFixed(6);
    elements.longitude.value = position.coords.longitude.toFixed(6);
    if (!elements.locationName.value.trim()) elements.locationName.value = "Home";
    elements.useDeviceLocationButton.disabled = false;
    elements.useDeviceLocationButton.textContent = "Use this device location";
    showToast("Location filled — save weather to enable forecast");
  }, (error) => {
    elements.useDeviceLocationButton.disabled = false;
    elements.useDeviceLocationButton.textContent = "Use this device location";
    showToast(error.message, true);
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
}

async function saveBackup() {
  if (requestInFlight) return;
  requestInFlight = true;
  elements.backupButton.disabled = true;
  elements.backupButton.textContent = "Capturing…";
  try {
    await api("/api/backups", {
      method: "POST",
      body: JSON.stringify({ label: "Controller snapshot" })
    });
    await loadBackups();
    showToast("Snapshot captured");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    requestInFlight = false;
    elements.backupButton.disabled = false;
    elements.backupButton.textContent = "Capture snapshot";
  }
}

async function restoreSavedBackup(id, label) {
  if (requestInFlight) return;
  if (!window.confirm(`Restore “${label}”? A pre-restore snapshot will be created automatically. Only verified fields will be written.`)) return;
  requestInFlight = true;
  updating = true;
  elements.backupList.classList.add("busy");
  try {
    const previous = state;
    state = await api(`/api/backups/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ confirm: true })
    });
    render(previous);
    await loadBackups();
    showToast(`${label} restored and verified`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    requestInFlight = false;
    updating = false;
    elements.backupList.classList.remove("busy");
    render();
    applyPendingLiveState();
  }
}

elements.powerButton.addEventListener("click", () => {
  if (state) update({ on: !state.on });
});
elements.refreshButton.addEventListener("click", () => refresh());
elements.refreshInterval.addEventListener("change", () => setRefreshInterval(elements.refreshInterval.value, true));
elements.backupButton.addEventListener("click", saveBackup);
elements.findLocationButton.addEventListener("click", async () => {
  elements.findLocationButton.disabled = true;
  elements.findLocationButton.textContent = "Finding…";
  try {
    await geocodeTypedLocation();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.findLocationButton.disabled = false;
    elements.findLocationButton.textContent = "Find location";
  }
});
elements.saveWeatherButton.addEventListener("click", async () => {
  elements.saveWeatherButton.disabled = true;
  elements.saveWeatherButton.textContent = "Saving…";
  try {
    await saveWeatherFromForm();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.saveWeatherButton.disabled = false;
    elements.saveWeatherButton.textContent = "Save weather";
  }
});
elements.useDeviceLocationButton.addEventListener("click", useDeviceLocation);
elements.saveAutomationButton.addEventListener("click", () => saveSmartConfig(readAutomationForm(), "Smart controls saved"));
elements.requestNotificationsButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    showToast("This browser does not support notifications", true);
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    elements.notificationsEnabled.checked = true;
    showToast("Notifications allowed on this device");
  } else {
    showToast("Notifications were not allowed", true);
  }
});
elements.testNotificationButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    showToast("This browser does not support notifications", true);
    return;
  }
  let permission = Notification.permission;
  if (permission !== "granted") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showToast("Notifications were not allowed", true);
    return;
  }
  sendBrowserNotification("AirTouch Local test", "Notifications are working on this device.");
  showToast("Test notification sent");
});
elements.settingsButton.addEventListener("click", () => {
  elements.settingsDialog.showModal();
  loadSettings();
});
elements.settingsCloseButton.addEventListener("click", () => elements.settingsDialog.close());
elements.settingsDialog.addEventListener("click", (event) => {
  if (event.target === elements.settingsDialog) elements.settingsDialog.close();
});
elements.backupList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-restore-backup]");
  if (button) restoreSavedBackup(button.dataset.restoreBackup, button.dataset.backupLabel);
});
elements.zonesGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-zone-toggle]");
  if (!button || !state || requestInFlight) return;
  const id = Number(button.dataset.zoneToggle);
  const groups = state.groups.map((group) => group.id === id ? { ...group, on: !group.on } : group);
  update({ groups });
});
elements.zonesGrid.addEventListener("input", (event) => {
  const slider = event.target.closest("[data-zone-airflow]");
  if (slider) setText(slider.closest(".zone-card").querySelector(".airflow-value"), `${slider.value}%`, false);
});
elements.zonesGrid.addEventListener("change", (event) => {
  const slider = event.target.closest("[data-zone-airflow]");
  if (slider) updateAirflow(Number(slider.dataset.zoneAirflow), Number(slider.value));
});

refresh(true);
loadSmartConfig().then(() => loadWeather());
setRefreshInterval(storedRefreshSeconds());
connectLiveUpdates();
setInterval(() => {
  elements.deviceClock.textContent = formatDeviceClock();
}, 1000);
setInterval(() => loadWeather(), 10 * 60 * 1000);
