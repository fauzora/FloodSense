import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";

function setup() {
  const saved = [];
  const events = [];
  const tileRequests = [];
  let thresholds = { warning_cm: 120, danger_cm: 180 };
  const database = {
    async insertReading(reading) {
      const row = { id: 1, ...reading };
      saved.push(row);
      return row;
    },
    async getHistory() { return saved; },
    async getNodes() { return []; },
    async getThresholds() { return thresholds; },
    async updateThresholds(value) {
      thresholds = value;
      return thresholds;
    },
    async getRiverStats() {
      return { segments: 35241, named_rivers: 812, total_length_km: 28413.5 };
    },
    async getRegions() {
      return {
        provinces: { type: "FeatureCollection", features: [] },
        mask: { type: "Feature", properties: {}, geometry: null },
        filterable: ["Jawa Barat"],
      };
    },
    async getRiverTile(request) {
      tileRequests.push(request);
      return Buffer.from([26, 0]);
    },
  };
  return {
    app: createApp({ database, broadcast: (event) => events.push(event) }),
    events,
    tileRequests,
  };
}

test("menolak payload yang tidak lengkap", async () => {
  const { app } = setup();
  const response = await request(app).post("/api/readings").send({ sensor_id: "node_hulu_01" });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Payload sensor tidak valid");
});

test("menyimpan, menghitung risiko, dan memancarkan pembacaan valid", async () => {
  const { app, events } = setup();
  const response = await request(app).post("/api/readings").send({
    sensor_id: "node_hilir_01",
    lokasi: "Hilir",
    water_level_cm: 185.5,
    flow_rate: 45.2,
    timestamp: "2026-08-15T10:00:00.000Z",
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.risk_status, "Bahaya");
  assert.equal(events.length, 1);
});

test("menerima indeks node tambahan dengan sektor yang sesuai", async () => {
  const { app } = setup();
  const response = await request(app).post("/api/readings").send({
    sensor_id: "node_hulu_05",
    lokasi: "Hulu",
    water_level_cm: 84,
    flow_rate: 16,
    timestamp: "2026-08-15T10:00:00.000Z",
  });
  assert.equal(response.status, 201);
});

test("menyimpan threshold dan memakainya untuk pembacaan berikutnya", async () => {
  const { app } = setup();
  const settingsResponse = await request(app)
    .put("/api/settings/thresholds")
    .send({ warning_cm: 160, danger_cm: 220 });
  assert.equal(settingsResponse.status, 200);

  const readingResponse = await request(app).post("/api/readings").send({
    sensor_id: "node_tengah_01",
    lokasi: "Tengah",
    water_level_cm: 150,
    flow_rate: 20,
    timestamp: "2026-08-15T10:00:00.000Z",
  });
  assert.equal(readingResponse.body.data.risk_status, "Normal");
});

test("menolak threshold bahaya yang tidak lebih tinggi", async () => {
  const { app } = setup();
  const response = await request(app)
    .put("/api/settings/thresholds")
    .send({ warning_cm: 180, danger_cm: 120 });
  assert.equal(response.status, 400);
});

test("menyajikan statistik sungai dari database", async () => {
  const { app } = setup();
  const response = await request(app).get("/api/rivers/stats");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.segments, 35241);
  assert.equal(response.body.data.source, "Badan Informasi Geospasial");
  assert.match(response.body.data.source_dataset, /1:25\.000/);
});

test("menyajikan vector tile sungai", async () => {
  const { app, tileRequests } = setup();
  const response = await request(app).get("/api/rivers/tiles/8/203/131.mvt?province=Jawa%20Barat");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /protobuf/);
  assert.equal(Number(response.headers["content-length"]), 2);
  assert.equal(tileRequests[0].province, "Jawa Barat");
});

test("menyajikan geometri batas wilayah Indonesia", async () => {
  const { app } = setup();
  const response = await request(app).get("/api/regions");
  assert.equal(response.status, 200);
  assert.equal(response.body.data.provinces.type, "FeatureCollection");
  assert.deepEqual(response.body.data.filterable, ["Jawa Barat"]);
});

test("menolak koordinat tile yang tidak valid", async () => {
  const { app } = setup();
  const response = await request(app).get("/api/rivers/tiles/25/0/0.mvt");
  assert.equal(response.status, 400);
});
