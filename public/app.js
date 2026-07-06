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
  powerButton: document.querySelector("#powerButton"),
  powerLabel: document.querySelector("#powerLabel"),
  packetHealth: document.querySelector("#packetHealth"),
  protocolMap: document.querySelector("#protocolMap"),
  rawPacket: document.querySelector("#rawPacket"),
  refreshButton: document.querySelector("#refreshButton"),
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
  timerSummary: document.querySelector("#timerSummary"),
  toast: document.querySelector("#toast"),
  zoneCount: document.querySelector("#zoneCount"),
  zonesGrid: document.querySelector("#zonesGrid")
};

let state = null;
let requestInFlight = false;
let updating = false;
let toastTimeout;

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
  const clamped = Math.max(10, Math.min(35, value));
  const hue = clamped <= 20
    ? Math.round(210 - ((clamped - 10) / 10) * 20)
    : Math.round(190 - ((clamped - 20) / 15) * 184);
  elements.climateCard.style.setProperty("--temp-hue", String(hue));
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
  if (group.spill) return "All regular zones are closed · switch this zone on to exit safety spill";
  if (group.turbo) return "Turbo airflow";
  return group.on ? "Airflow on" : "Airflow off";
}

function zoneMarkup(group) {
  const airflowDisabled = updating || !state.on || !group.on || group.spill || group.turbo;
  return `
    <article class="zone-card${group.on ? " active" : ""}${group.spill ? " spilling" : ""}" data-zone-id="${group.id}">
      ${group.spill ? `<div class="spill-alert" role="status">
        <span class="spill-alert-dot" aria-hidden="true"></span>
        <strong>Safety spill active</strong>
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
    ? `Safety spill is protecting the system · ${spillZone.name} open ${spillZone.openPercent}%`
    : isOn
      ? `${activeZones} of ${state.groups.length} zones are receiving air`
      : "Your system is resting", animate);
  elements.climateCard.classList.toggle("on", isOn);
  setText(elements.systemState, state.error ? "Needs attention" : isOn ? "Running" : "Standby", animate);
  setText(elements.systemNote, state.error
    ? "Controller reported an AC fault"
    : spillZone
      ? "All regular zones are closed; the spill vent is preventing pressure damage"
      : isOn
        ? "Conditioning your active zones"
        : "Ready when you are", animate);
  setText(elements.temperatureValue, state.temperature ?? "—", animate);
  setText(elements.temperatureFeeling, temperatureFeeling(state.temperature), animate);
  applyTemperatureTheme(state.temperature);
  elements.powerButton.setAttribute("aria-pressed", String(isOn));
  setText(elements.powerLabel, isOn ? "Turn off" : "Turn on", animate);
  setText(elements.zoneCount, spillZone ? `Safety spill · ${spillZone.openPercent}%` : `${activeZones} active`, animate);
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
  }
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
  await loadBackups();
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
  }
}

elements.powerButton.addEventListener("click", () => {
  if (state) update({ on: !state.on });
});
elements.refreshButton.addEventListener("click", () => refresh());
elements.backupButton.addEventListener("click", saveBackup);
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
setInterval(() => {
  elements.deviceClock.textContent = formatDeviceClock();
}, 1000);
setInterval(() => {
  if (!document.hidden && !requestInFlight) refresh(true);
}, 30_000);
