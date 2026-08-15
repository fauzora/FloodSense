import express from "express";
import cors from "cors";
import { calculateRisk } from "./risk.js";
import { sensorReadingSchema, thresholdSchema } from "./validation.js";

export function createApp({ database, broadcast = () => {} }) {
  const app = express();
  const clientOrigins = (process.env.CLIENT_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",").map((origin) => origin.trim());
  app.use(cors({ origin: clientOrigins }));
  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", service: "FloodSense API" });
  });

  app.post("/api/readings", async (request, response, next) => {
    try {
      const parsed = sensorReadingSchema.safeParse(request.body);
      if (!parsed.success) {
        return response.status(400).json({
          error: "Payload sensor tidak valid",
          details: parsed.error.issues.map(({ path, message }) => ({
            field: path.join("."), message,
          })),
        });
      }

      const reading = {
        ...parsed.data,
        risk_status: calculateRisk(parsed.data.water_level_cm, await database.getThresholds()),
      };
      const saved = await database.insertReading(reading);
      const event = { type: "sensor_reading.created", data: saved };
      broadcast(event);
      return response.status(201).json(event);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/readings", async (request, response, next) => {
    try {
      const limit = Math.min(Math.max(Number(request.query.limit) || 100, 1), 500);
      const readings = await database.getHistory({
        sensorId: request.query.sensor_id,
        limit,
      });
      response.json({ data: readings });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/nodes", async (_request, response, next) => {
    try {
      response.json({ data: await database.getNodes() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/settings/thresholds", async (_request, response, next) => {
    try {
      response.json({ data: await database.getThresholds() });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/settings/thresholds", async (request, response, next) => {
    try {
      const parsed = thresholdSchema.safeParse(request.body);
      if (!parsed.success) {
        return response.status(400).json({
          error: "Risk threshold tidak valid",
          details: parsed.error.issues.map(({ path, message }) => ({
            field: path.join("."), message,
          })),
        });
      }
      return response.json({ data: await database.updateThresholds(parsed.data) });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/rivers/stats", async (_request, response, next) => {
    try {
      response.json({
        data: {
          ...await database.getRiverStats(),
          coverage: "Pulau Jawa",
          source: "Badan Informasi Geospasial",
          source_dataset: "Rupabumi Indonesia 1:25.000 — Sungai (Garis)",
          source_url: "https://geoservices.big.go.id/rbi/rest/services/BASEMAP/Rupabumi_Indonesia/MapServer/566",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/regions", async (_request, response, next) => {
    try {
      response.json({ data: await database.getRegions() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/rivers/tiles/:z/:x/:y.mvt", async (request, response, next) => {
    try {
      const z = Number(request.params.z);
      const x = Number(request.params.x);
      const y = Number(request.params.y);
      const tileLimit = Number.isInteger(z) ? 2 ** z : 0;
      if (![z, x, y].every(Number.isInteger)
        || z < 5 || z > 14
        || x < 0 || y < 0 || x >= tileLimit || y >= tileLimit) {
        return response.status(400).json({ error: "Koordinat tile tidak valid" });
      }
      const province = typeof request.query.province === "string"
        ? request.query.province.trim().slice(0, 80) || null
        : null;
      const tile = await database.getRiverTile({ z, x, y, province });
      response.set({
        "Content-Type": "application/x-protobuf",
        "Cache-Control": "public, max-age=604800, immutable",
      });
      return response.send(tile || Buffer.alloc(0));
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    console.error(error);
    response.status(500).json({ error: "Terjadi kesalahan pada server" });
  });

  return app;
}
