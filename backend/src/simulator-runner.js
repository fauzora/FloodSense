import { sensorNodes } from "./sensor-nodes.js";

export function startSimulator({
  apiUrl = process.env.API_URL || "http://localhost:3001",
  intervalMs = Number(process.env.SIMULATOR_INTERVAL_MS) || 3000,
  logReadings = process.env.SIMULATOR_LOG_READINGS !== "false",
} = {}) {
  let tick = 0;

  async function sendReading(node) {
    const wave = Math.sin((tick + sensorNodes.indexOf(node) * 2) / 3) * 8;
    const goldenPath = node.lokasi === "Hilir" ? Math.min((tick % 18) * 2.2, 35) : 0;
    const payload = {
      sensor_id: node.sensor_id,
      lokasi: node.lokasi,
      water_level_cm: Number((node.base + wave + goldenPath).toFixed(1)),
      flow_rate: Number((node.flow + wave / 3 + goldenPath / 5).toFixed(1)),
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(`${apiUrl}/api/readings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`API merespons ${response.status}`);
    if (logReadings) {
      const result = await response.json();
      console.log(`${node.lokasi.padEnd(6)} ${payload.water_level_cm} cm — ${result.data.risk_status}`);
    }
  }

  async function simulate() {
    await Promise.all(sensorNodes.map(sendReading));
    tick += 1;
  }

  console.log(`Simulator mengirim data ke ${apiUrl} setiap ${intervalMs} ms`);
  simulate().catch(console.error);
  const timer = setInterval(() => simulate().catch(console.error), intervalMs);
  return () => clearInterval(timer);
}
