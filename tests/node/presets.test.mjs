// Port of TestBuiltinPresets from tests/test_scripts.py.orig.
// Validates the JSON structure of skills/drawio-skill/styles/built-in/*.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const DIR = new URL("../../skills/drawio-skill/styles/built-in/", import.meta.url).pathname;
const HEX6 = /^#[0-9a-fA-F]{6}$/;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
const presets = files.map((f) => ({ file: f, data: JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) }));

test("presets: required built-in set is present", () => {
  const names = new Set(presets.map((p) => p.data.name));
  for (const required of ["default", "corporate", "handdrawn", "colorblind-safe", "dark"]) {
    assert.ok(names.has(required), `missing preset: ${required}`);
  }
});

test("presets: each preset's name matches its filename", () => {
  for (const { file, data } of presets) {
    assert.equal(data.name, path.basename(file, ".json"));
  }
});

test("presets: built-in presets are not marked default", () => {
  for (const { data } of presets) {
    assert.ok(!data.default, `${data.name} should not be default`);
  }
});

test("presets: palette slot colours are valid 6-digit hex when present", () => {
  const slots = ["primary", "success", "warning", "accent", "danger", "neutral", "secondary"];
  for (const { data } of presets) {
    for (const slot of slots) {
      const entry = data.palette && data.palette[slot];
      if (!entry) continue;
      if (entry.fillColor) assert.match(entry.fillColor, HEX6, `${data.name}.${slot}.fillColor`);
      if (entry.strokeColor) assert.match(entry.strokeColor, HEX6, `${data.name}.${slot}.strokeColor`);
    }
  }
});

test("presets: extras background/fontColor/edgeColor are valid hex when present", () => {
  for (const { data } of presets) {
    const extras = data.extras || {};
    for (const key of ["background", "fontColor", "edgeColor"]) {
      if (extras[key]) assert.match(extras[key], HEX6, `${data.name}.extras.${key}`);
    }
  }
});
