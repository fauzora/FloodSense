import "dotenv/config";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import { createDatabase } from "./database.js";
import { createApp } from "./app.js";
import { startSimulator } from "./simulator-runner.js";

const port = Number(process.env.PORT) || 3001;
const clientOrigins = (process.env.CLIENT_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((origin) => origin.trim());
const database = createDatabase();
await database.initialize();

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: clientOrigins },
});
const app = createApp({
  database,
  broadcast: (event) => io.emit("sensor:reading", event),
});

if (process.env.STATIC_DIR) {
  app.use(express.static(process.env.STATIC_DIR));
  app.get("/{*path}", (_request, response) => {
    response.sendFile("index.html", { root: process.env.STATIC_DIR });
  });
}

httpServer.on("request", app);
let stopSimulator;
let importer;
httpServer.listen(port, () => {
  console.log(`FloodSense API aktif di http://localhost:${port}`);
  if (process.env.ENABLE_SIMULATOR === "true") {
    stopSimulator = startSimulator({ apiUrl: `http://127.0.0.1:${port}` });
  }
  if (process.env.AUTO_IMPORT_RIVERS === "true") {
    importer = spawn(process.execPath, [fileURLToPath(new URL("./import-rivers.js", import.meta.url))], {
      env: process.env,
      stdio: "inherit",
    });
    importer.on("error", (error) => console.error("Importer sungai gagal dimulai:", error));
  }
});

async function shutdown() {
  stopSimulator?.();
  importer?.kill();
  io.close();
  httpServer.close();
  await database.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
