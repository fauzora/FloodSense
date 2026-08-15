import { z } from "zod";
import { sensorNodes } from "./sensor-nodes.js";

const sensorIds = sensorNodes.map((node) => node.sensor_id);

export const sensorReadingSchema = z.object({
  sensor_id: z.enum(sensorIds),
  lokasi: z.enum(["Hulu", "Tengah", "Hilir"]),
  water_level_cm: z.number().min(0).max(1000),
  flow_rate: z.number().min(0).max(1000),
  timestamp: z.iso.datetime(),
}).superRefine((value, context) => {
  const expected = value.sensor_id.split("_")[1];
  if (value.lokasi.toLowerCase() !== expected) {
    context.addIssue({
      code: "custom",
      path: ["lokasi"],
      message: "lokasi tidak sesuai dengan sensor_id",
    });
  }
});

export const thresholdSchema = z.object({
  warning_cm: z.number().min(1).max(999),
  danger_cm: z.number().min(2).max(1000),
}).refine((value) => value.danger_cm > value.warning_cm, {
  message: "danger_cm harus lebih besar dari warning_cm",
  path: ["danger_cm"],
});
