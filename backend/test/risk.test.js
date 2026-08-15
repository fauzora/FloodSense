import test from "node:test";
import assert from "node:assert/strict";
import { calculateRisk } from "../src/risk.js";

test("menghitung status pada batas threshold", () => {
  assert.equal(calculateRisk(119.99), "Normal");
  assert.equal(calculateRisk(120), "Waspada");
  assert.equal(calculateRisk(179.99), "Waspada");
  assert.equal(calculateRisk(180), "Bahaya");
});
