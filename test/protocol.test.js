"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  StatusPacket,
  buildAirflowStepCommand,
  buildControlCommand,
  buildGroupNameCommand,
  checksum,
  extractStatus,
  parseStatus,
  queryCommand
} = require("../protocol");

function setByte(hex, position, value) {
  const offset = (position - 1) * 2;
  return hex.slice(0, offset) + value.toString(16).padStart(2, "0") + hex.slice(offset + 2);
}

function setAscii(hex, position, length, text) {
  const padded = text.padEnd(length, " ").slice(0, length);
  let result = hex;
  for (let index = 0; index < length; index += 1) {
    result = setByte(result, position + index, padded.charCodeAt(index));
  }
  return result;
}

function fixture() {
  let hex = "00".repeat(353);
  hex = setByte(hex, 1, 0x66);
  hex = setByte(hex, 2, 0xfa);
  hex = setByte(hex, 3, 0x80);
  hex = setByte(hex, 4, 1);
  hex = setByte(hex, 280, 3);
  hex = setAscii(hex, 104, 8, "Family");
  hex = setAscii(hex, 112, 8, "Master");
  hex = setAscii(hex, 120, 8, "Bedrooms");
  hex = setByte(hex, 248, 0x01);
  hex = setByte(hex, 249, 0x10);
  hex = setByte(hex, 250, 0x20);
  hex = setByte(hex, 232, 0x80);
  hex = setByte(hex, 233, 0x80);
  hex = setByte(hex, 234, 0x00);
  hex = setByte(hex, 264, 10);
  hex = setByte(hex, 265, 10);
  hex = setByte(hex, 266, 10);
  hex = setByte(hex, 310, 10);
  hex = setByte(hex, 311, 6);
  hex = setByte(hex, 312, 3);
  hex = setByte(hex, 326, 16);
  hex = setAscii(hex, 327, 16, "Polyaire");
  hex = setByte(hex, 343, 20);
  hex = setByte(hex, 344, 26);
  hex = setByte(hex, 345, 6);
  hex = setByte(hex, 346, 5);
  hex = setByte(hex, 347, 19);
  hex = setByte(hex, 348, 22);
  hex = setByte(hex, 353, Number.parseInt(checksum(hex.slice(0, -2)), 16));
  return hex;
}

test("builds the legacy status query with checksum", () => {
  assert.equal(queryCommand(), "55000C00000000000000000061");
  assert.equal(checksum("55000C"), "61");
});

test("extracts and parses a status packet", () => {
  const hex = fixture();
  assert.equal(extractStatus(`{\"response\":\"noise${hex}\"}`), hex);
  const status = parseStatus(hex);
  assert.equal(status.on, true);
  assert.equal(status.temperature, 16);
  assert.equal(status.owner, "Polyaire");
  assert.deepEqual(status.controllerDate, { year: 2026, month: 7, day: 6 });
  assert.deepEqual(status.groups.map(({ name, on }) => ({ name, on })), [
    { name: "Family", on: true },
    { name: "Master", on: true },
    { name: "Bedrooms", on: false }
  ]);
  assert.deepEqual(status.groups.map(({ openPercent }) => openPercent), [100, 60, 30]);
  assert.equal(status.groups[0].physicalZones[0].balancePercent, 100);
  assert.equal(status.protocol.checksumValid, true);
  assert.equal(status.protocol.fields.find((field) => field.start === 327).value, "\"Polyaire\"");
  assert.equal(status.protocol.fields.find((field) => field.start === 327).type, "ASCII[16]");
  assert.equal(status.protocol.fields.find((field) => field.start === 343).value, "2026-07-06");
  assert.equal(new StatusPacket(hex).byte(311), 6);
});

test("builds a verified group-name restore command", () => {
  const command = buildGroupNameCommand(1, "Master");
  assert.equal(command.slice(0, 8), "55830C81");
  assert.equal(Buffer.from(command.slice(8, 24), "hex").toString("ascii"), "Master  ");
  assert.equal(command.slice(-2), checksum(command.slice(0, -2)).toUpperCase());
});

test("builds bounded 10% airflow commands", () => {
  assert.equal(buildAirflowStepCommand(1, "up"), "55010C01000000000000000063");
  assert.equal(buildAirflowStepCommand(1, "down"), "55010C02000000000000000064");
  assert.equal(buildAirflowStepCommand(0, "up"), "55010C10000000000000000072");
  assert.throws(() => buildAirflowStepCommand(16, "up"));
});

test("builds an AC and zone control command", () => {
  const status = parseStatus(fixture());
  const command = buildControlCommand(status, {
    on: false,
    groups: { 0: true, 1: false, 2: true }
  });
  assert.equal(command.slice(2, 4), "08");
  assert.equal(command.slice(6, 9), "848");
  assert.equal(command.slice(22, 24), "40");
  assert.equal(command.slice(-2), checksum(command.slice(0, -2)));
});
