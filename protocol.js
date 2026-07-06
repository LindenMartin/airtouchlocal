"use strict";

const QUERY_BODY = "55000C000000000000000000";
const INFO_HEAD = "66fa";
const INFO_BYTES = 353;

const ZONE_OF_GROUP = Array.from({ length: 16 }, (_, index) => 248 + index);
const ZONE_STATE = Array.from({ length: 16 }, (_, index) => 232 + index);
const ZONE_BALANCE = Array.from({ length: 16 }, (_, index) => 264 + index);
const GROUP_OPEN = Array.from({ length: 16 }, (_, index) => 310 + index);

const STATUS_FIELDS = [
  { name: "Header", start: 1, end: 2, type: "byte[2]", confidence: "confirmed" },
  { name: "AC state flags", start: 3, end: 3, type: "bitfield", confidence: "confirmed" },
  { name: "AC capability flags", start: 4, end: 4, type: "bitfield", confidence: "partial" },
  { name: "Unknown", start: 5, end: 5, type: "byte", confidence: "unknown" },
  { name: "Programs and schedules", start: 6, end: 103, type: "byte[98]", confidence: "partial" },
  { name: "Group names (16 × 8 bytes)", start: 104, end: 231, type: "ASCII[16][8]", confidence: "confirmed" },
  { name: "Physical-zone state", start: 232, end: 247, type: "bitfield[16]", confidence: "confirmed" },
  { name: "Group-to-zone mapping", start: 248, end: 263, type: "packed uint4[32]", confidence: "partial" },
  { name: "Physical-zone balance (×10%)", start: 264, end: 279, type: "uint8[16]", confidence: "confirmed" },
  { name: "Group count", start: 280, end: 280, type: "uint8", confidence: "confirmed" },
  { name: "Physical-zone count", start: 281, end: 281, type: "uint8", confidence: "likely" },
  { name: "Unknown system parameters", start: 282, end: 283, type: "byte[2]", confidence: "unknown" },
  { name: "Bypass configuration flags", start: 284, end: 284, type: "bitfield", confidence: "partial" },
  { name: "Turbo group", start: 285, end: 285, type: "uint4", confidence: "confirmed" },
  { name: "Turbo/bypass active flags", start: 286, end: 286, type: "bitfield", confidence: "partial" },
  { name: "Installer contact", start: 287, end: 308, type: "ASCII[22]", confidence: "confirmed" },
  { name: "Unknown", start: 309, end: 309, type: "byte", confidence: "unknown" },
  { name: "Group airflow opening (×10%)", start: 310, end: 325, type: "uint8[16]", confidence: "confirmed" },
  { name: "Home temperature", start: 326, end: 326, type: "uint8 °C", confidence: "confirmed" },
  { name: "Owner name", start: 327, end: 342, type: "ASCII[16]", confidence: "confirmed" },
  { name: "Controller date", start: 343, end: 346, type: "date (zero-based M/D)", confidence: "confirmed" },
  { name: "Controller time", start: 347, end: 348, type: "time[2]", confidence: "confirmed" },
  { name: "AC on/off timers", start: 349, end: 352, type: "timer[2]", confidence: "confirmed" },
  { name: "Additive checksum", start: 353, end: 353, type: "uint8", confidence: "confirmed" }
];

function byteAt(hex, oneBasedPosition) {
  return Number.parseInt(hex.slice((oneBasedPosition - 1) * 2, oneBasedPosition * 2), 16);
}

function checksum(hex) {
  if (hex.length % 2 !== 0) throw new Error("Command must contain whole bytes");
  let total = 0;
  for (let offset = 0; offset < hex.length; offset += 2) {
    total += Number.parseInt(hex.slice(offset, offset + 2), 16);
  }
  return (total & 0xff).toString(16).padStart(2, "0");
}

function replaceByte(hex, oneBasedPosition, value) {
  const offset = (oneBasedPosition - 1) * 2;
  return hex.slice(0, offset) + value + hex.slice(offset + 2);
}

function replaceNibble(hex, zeroBasedPosition, value) {
  return hex.slice(0, zeroBasedPosition) + value + hex.slice(zeroBasedPosition + 1);
}

function queryCommand() {
  return QUERY_BODY + checksum(QUERY_BODY);
}

class StatusPacket {
  constructor(hex) {
    if (!hex || hex.length !== INFO_BYTES * 2 || hex.slice(0, 4).toLowerCase() !== INFO_HEAD) {
      throw new Error("Controller returned an invalid status packet");
    }
    this.hex = hex.toUpperCase();
  }

  byte(position) {
    return byteAt(this.hex, position);
  }

  text(position, length) {
    return ascii(this.hex, position, length);
  }

  bytes(start, end = start) {
    return this.hex.slice((start - 1) * 2, end * 2);
  }

  checksumValid() {
    return checksum(this.hex.slice(0, -2)).toUpperCase() === this.hex.slice(-2);
  }

  humanValue(field) {
    const values = Array.from({ length: field.end - field.start + 1 }, (_, index) => this.byte(field.start + index));
    const quotedText = (start, length) => JSON.stringify(this.text(start, length));
    switch (field.start) {
      case 1: return "AirTouch status response (0x66FA)";
      case 3: return `${values[0] & 0x80 ? "On" : "Off"} · ${values[0] & 0x40 ? "fault" : "no fault"}`;
      case 4: return values[0] ? `Controller available · 0x${this.bytes(4)}` : "Controller unavailable";
      case 104: {
        const names = Array.from({ length: 16 }, (_, index) => this.text(104 + index * 8, 8)).filter(Boolean);
        return JSON.stringify(names);
      }
      case 232: return values.map((value, index) => `Z${index + 1}:${value & 0x80 ? "on" : "off"}${value & 0x40 ? "/spill" : ""}`).join(", ");
      case 248: return values.map((value, index) => `G${index + 1}→Z${(value >> 4) + 1}×${value & 0x0f}`).join(", ");
      case 264: return values.map((value) => `${value * 10}%`).join(", ");
      case 280: return String(values[0]);
      case 281: return String(values[0]);
      case 284: return `0x${this.bytes(284)}${values[0] & 0x80 ? " · bypass configured" : ""}`;
      case 285: return (values[0] & 0x0f) ? `Group ${values[0] & 0x0f}` : "None";
      case 286: return `0x${this.bytes(286)}${values[0] & 0x20 ? " · turbo active" : ""}${values[0] & 0x10 ? " · bypass active" : ""}`;
      case 287: return quotedText(287, 22);
      case 310: return values.map((value) => `${value * 10}%`).join(", ");
      case 326: return values[0] === 255 ? "Not available" : `${values[0]} °C`;
      case 327: return quotedText(327, 16);
      case 343: return `${String(values[0]).padStart(2, "0")}${String(values[1]).padStart(2, "0")}-${String(values[2] + 1).padStart(2, "0")}-${String(values[3] + 1).padStart(2, "0")}`;
      case 347: return `${String(values[0]).padStart(2, "0")}:${String(values[1]).padStart(2, "0")}`;
      case 349: {
        const describeTimer = (hour, minute) => `${hour & 0x80 ? "enabled" : "disabled"} ${String(hour & 0x7f).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        return `On ${describeTimer(values[0], values[1])} · Off ${describeTimer(values[2], values[3])}`;
      }
      case 353: return `0x${this.bytes(353)} · ${this.checksumValid() ? "valid" : "invalid"}`;
      default: return field.confidence === "unknown"
        ? `Unknown, preserved as 0x${this.bytes(field.start, field.end)}`
        : values.map((value) => `0x${value.toString(16).padStart(2, "0").toUpperCase()}`).join(" ");
    }
  }

  describe() {
    return {
      length: INFO_BYTES,
      checksumValid: this.checksumValid(),
      fields: STATUS_FIELDS.map((field) => ({
        ...field,
        hex: this.bytes(field.start, field.end),
        value: this.humanValue(field)
      })),
      raw: this.hex
    };
  }
}

function extractStatus(responseText) {
  const text = String(responseText || "");
  const position = text.toLowerCase().lastIndexOf(INFO_HEAD);
  if (position < 0) return null;
  const status = text.slice(position, position + INFO_BYTES * 2);
  return status.length === INFO_BYTES * 2 ? status : null;
}

function ascii(hex, start, length) {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    const value = byteAt(hex, start + index);
    result += value >= 32 && value <= 126 ? String.fromCharCode(value) : " ";
  }
  return result.trim();
}

function parseTimer(hourByte, minute) {
  return {
    enabled: Boolean(hourByte & 0x80),
    hour: hourByte & 0x7f,
    minute
  };
}

function parseStatus(hex) {
  const packet = new StatusPacket(hex);

  const flags = packet.byte(3);
  const groupCount = Math.min(packet.byte(280), 16);
  const turboGroup = packet.byte(285) & 0x0f;
  const turboEnabled = Boolean((packet.byte(286) >> 5) & 1);
  const groups = [];

  for (let index = 0; index < groupCount; index += 1) {
    const mapping = packet.byte(ZONE_OF_GROUP[index]);
    const zoneNumber = (mapping >> 4) & 0x0f;
    const zoneCount = mapping & 0x0f;
    const zoneFlags = packet.byte(ZONE_STATE[zoneNumber]);
    const openStep = packet.byte(GROUP_OPEN[index]);
    groups.push({
      id: index,
      name: packet.text(104 + index * 8, 8) || `Zone ${index + 1}`,
      on: Boolean(zoneFlags & 0x80),
      spill: Boolean(zoneFlags & 0x40),
      turboCapable: turboGroup === index + 1,
      turbo: turboGroup === index + 1 && turboEnabled,
      openStep,
      openPercent: openStep * 10,
      physicalZones: Array.from({ length: zoneCount }, (_, offset) => {
        const id = zoneNumber + offset;
        const balanceStep = packet.byte(ZONE_BALANCE[id]);
        return {
          id,
          balanceStep,
          balancePercent: balanceStep * 10
        };
      })
    });
  }

  return {
    available: packet.byte(4) !== 0,
    on: Boolean(flags & 0x80),
    error: Boolean(flags & 0x40),
    bypass: Boolean(packet.byte(284) & 0x80) && Boolean(packet.byte(286) & 0x10),
    temperature: packet.byte(326) === 255 ? null : packet.byte(326),
    owner: packet.text(327, 16) || "Home",
    controllerDate: {
      year: packet.byte(343) * 100 + packet.byte(344),
      month: packet.byte(345) + 1,
      day: packet.byte(346) + 1
    },
    controllerTime: {
      hour: packet.byte(347),
      minute: packet.byte(348)
    },
    timers: {
      on: parseTimer(packet.byte(349), packet.byte(350)),
      off: parseTimer(packet.byte(351), packet.byte(352))
    },
    groups,
    protocol: packet.describe()
  };
}

function buildControlCommand(current, desired) {
  let command = QUERY_BODY.slice(0, 24);
  command = replaceByte(command, 2, "08");
  command = replaceByte(command, 12, desired.on ? "80" : "40");

  const requestedGroups = desired.groups || {};
  current.groups.forEach((group, index) => {
    const on = Object.prototype.hasOwnProperty.call(requestedGroups, group.id)
      ? Boolean(requestedGroups[group.id])
      : group.on;
    command = replaceNibble(command, 6 + index, on ? "8" : "4");
  });

  return command + checksum(command);
}

function buildAirflowStepCommand(groupId, direction) {
  if (!Number.isInteger(groupId) || groupId < 0 || groupId > 15) {
    throw new Error("Group id must be between 0 and 15");
  }
  if (direction !== "up" && direction !== "down") {
    throw new Error("Airflow direction must be up or down");
  }

  const bytes = Buffer.alloc(13);
  bytes[0] = 0x55;
  bytes[1] = 0x01;
  bytes[2] = 0x0c;
  const dataByte = 3 + Math.floor(groupId / 2);
  const action = direction === "up" ? 0x01 : 0x02;
  bytes[dataByte] = groupId % 2 === 0 ? action << 4 : action;
  bytes[12] = bytes.subarray(0, 12).reduce((sum, value) => (sum + value) & 0xff, 0);
  return bytes.toString("hex").toUpperCase();
}

function buildGroupNameCommand(groupId, name) {
  if (!Number.isInteger(groupId) || groupId < 0 || groupId > 15) {
    throw new Error("Group id must be between 0 and 15");
  }
  if (typeof name !== "string" || !/^[\x20-\x7e]{0,8}$/.test(name)) {
    throw new Error("Group name must be up to 8 printable ASCII characters");
  }
  const bytes = Buffer.alloc(13, 0x20);
  bytes[0] = 0x55;
  bytes[1] = 0x83;
  bytes[2] = 0x0c;
  bytes[3] = 0x80 + groupId;
  Buffer.from(name, "ascii").copy(bytes, 4);
  bytes[12] = bytes.subarray(0, 12).reduce((sum, value) => (sum + value) & 0xff, 0);
  return bytes.toString("hex").toUpperCase();
}

module.exports = {
  INFO_BYTES,
  StatusPacket,
  buildAirflowStepCommand,
  buildControlCommand,
  buildGroupNameCommand,
  checksum,
  extractStatus,
  parseStatus,
  queryCommand
};
