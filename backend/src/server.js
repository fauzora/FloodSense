import "dotenv/config";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { createDatabase } from "./database.js";
import { createApp } from "./app.js";

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
httpServer.on("request", app);
httpServer.listen(port, () => {
  console.log(`FloodSense API aktif di http://localhost:${port}`);
});

async function shutdown() {
  io.close();
  httpServer.close();
  await database.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
