<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { io } from "socket.io-client";
import RiverMap from "./components/RiverMap.vue";
import TelemetryChart from "./components/TelemetryChart.vue";
import {
  Activity, ChevronRight, CircleGauge, Database, Download, Droplets,
  FileChartColumn, Gauge, LayoutDashboard, Map, Menu, Radio, Search,
  Settings, ShieldAlert, SlidersHorizontal, Waves, X,
} from "lucide-vue-next";

const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3001";
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN || "";
const pages = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "map", label: "Map View", icon: Map },
  { id: "nodes", label: "Sensor Nodes", icon: Radio },
  { id: "reports", label: "Reports", icon: FileChartColumn },
  { id: "settings", label: "System Settings", icon: Settings },
];
const activePage = ref(location.hash.slice(1) || "dashboard");
const mobileNav = ref(false);
const connected = ref(false);
const readings = ref([]);
const thresholds = ref({ warning_cm: 120, danger_cm: 180 });
const thresholdDraft = ref({ warning_cm: 120, danger_cm: 180 });
const thresholdMessage = ref("");
const thresholdSaving = ref(false);
const nodes = ref([
  { sensor_id: "node_hulu_01", lokasi: "Hulu", latitude: -6.5879, longitude: 106.8051, water_level_cm: 82, flow_rate: 15, risk_status: "Normal", timestamp: new Date().toISOString() },
  { sensor_id: "node_tengah_01", lokasi: "Tengah", latitude: -6.3712, longitude: 106.8296, water_level_cm: 138, flow_rate: 28, risk_status: "Waspada", timestamp: new Date().toISOString() },
  { sensor_id: "node_hilir_01", lokasi: "Hilir", latitude: -6.1754, longitude: 106.8272, water_level_cm: 185, flow_rate: 45, risk_status: "Bahaya", timestamp: new Date().toISOString() },
]);
const selectedId = ref("node_hilir_01");
let socket;

const statusRank = { Normal: 1, Waspada: 2, Bahaya: 3 };
const worstNode = computed(() => [...nodes.value].sort((a, b) => statusRank[b.risk_status] - statusRank[a.risk_status])[0]);
const selectedNode = computed(() => nodes.value.find((node) => node.sensor_id === selectedId.value) || nodes.value[0]);
const highestNode = computed(() => [...nodes.value].sort((a, b) => b.water_level_cm - a.water_level_cm)[0]);
const pageTitle = computed(() => pages.find((page) => page.id === activePage.value)?.label || "Dashboard");

function statusClass(status) {
  return {
    Normal: "text-emerald-400 bg-emerald-400/10 border-emerald-400/25",
    Waspada: "text-amber-300 bg-amber-400/10 border-amber-400/25",
    Bahaya: "text-rose-400 bg-rose-400/10 border-rose-400/25",
  }[status] || "text-slate-400";
}

function statusColor(status) {
  return { Normal: "#34d399", Waspada: "#fbbf24", Bahaya: "#fb7185" }[status] || "#94a3b8";
}

function timeLabel(value) {
  return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function dateLabel(value) {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function setPage(page) {
  activePage.value = page;
  location.hash = page;
  mobileNav.value = false;
}

async function viewNodeDetail(node) {
  selectedId.value = node.sensor_id;
  setPage("dashboard");
  await nextTick();
  window.setTimeout(() => {
    document.querySelector("main section.mt-4.grid > .card:last-child")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 50);
}

function exportReport() {
  const rows = readings.value.length ? readings.value : nodes.value;
  const header = ["timestamp", "sensor_id", "station_name", "sector", "water_level_cm", "flow_rate_m3s", "risk_status"];
  const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [header, ...rows.map((row) => {
    const node = nodes.value.find((item) => item.sensor_id === row.sensor_id);
    return [row.timestamp, row.sensor_id, node?.station_name, row.lokasi || node?.lokasi,
      row.water_level_cm, row.flow_rate, row.risk_status];
  })].map((row) => row.map(escapeCsv).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `floodsense-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveThresholds() {
  thresholdMessage.value = "";
  thresholdSaving.value = true;
  try {
    const response = await fetch(`${apiUrl}/api/settings/thresholds`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(thresholdDraft.value),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.details?.[0]?.message || payload.error);
    thresholds.value = payload.data;
    thresholdDraft.value = { ...payload.data };
    thresholdMessage.value = "Threshold tersimpan dan aktif untuk pembacaan berikutnya.";
  } catch (error) {
    thresholdMessage.value = error.message || "Threshold gagal disimpan.";
  } finally {
    thresholdSaving.value = false;
  }
}

function receiveReading(reading) {
  readings.value = [reading, ...readings.value.filter((item) => item.id !== reading.id)].slice(0, 100);
  const index = nodes.value.findIndex((node) => node.sensor_id === reading.sensor_id);
  if (index >= 0) nodes.value[index] = { ...nodes.value[index], ...reading };
}

async function loadData() {
  try {
    const [nodeResponse, historyResponse, thresholdResponse] = await Promise.all([
      fetch(`${apiUrl}/api/nodes`),
      fetch(`${apiUrl}/api/readings?limit=100`),
      fetch(`${apiUrl}/api/settings/thresholds`),
    ]);
    if (nodeResponse.ok) {
      const payload = await nodeResponse.json();
      if (payload.data.some((node) => node.timestamp)) nodes.value = payload.data;
    }
    if (historyResponse.ok) readings.value = (await historyResponse.json()).data;
    if (thresholdResponse.ok) {
      thresholds.value = (await thresholdResponse.json()).data;
      thresholdDraft.value = { ...thresholds.value };
    }
  } catch {
    // Data contoh tetap ditampilkan saat backend belum aktif.
  }
}

onMounted(() => {
  loadData();
  socket = io(apiUrl, { transports: ["websocket", "polling"] });
  socket.on("connect", () => { connected.value = true; });
  socket.on("disconnect", () => { connected.value = false; });
  socket.on("sensor:reading", (event) => receiveReading(event.data));
  window.addEventListener("hashchange", () => { activePage.value = location.hash.slice(1) || "dashboard"; });
});

onBeforeUnmount(() => socket?.disconnect());
</script>

<template>
  <div class="min-h-screen bg-ink grid-fade">
    <aside v-if="activePage !== 'public'" :class="['fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-[#07101c] transition-transform lg:translate-x-0', mobileNav ? 'translate-x-0' : '-translate-x-full']">
      <div class="flex h-20 items-center gap-3 border-b border-line px-6">
        <div class="grid h-9 w-9 place-items-center rounded-lg bg-cyan text-ink shadow-[0_0_24px_rgba(39,216,232,.25)]"><Waves :size="20" /></div>
        <div><div class="text-lg font-bold tracking-tight text-white">Flood<span class="text-cyan">Sense</span></div><div class="eyebrow">BPBD Monitoring</div></div>
        <button class="ml-auto lg:hidden" aria-label="Tutup menu" @click="mobileNav = false"><X :size="20" /></button>
      </div>
      <div class="mx-4 mt-5 rounded-lg border border-cyan/15 bg-cyan/5 p-3">
        <div class="flex items-center gap-2 text-xs font-semibold text-cyan"><span class="status-dot bg-cyan text-cyan"></span> SYSTEM ONLINE</div>
        <div class="mt-1 text-[10px] text-slate-500">{{ nodes.length }} sensor node terhubung</div>
      </div>
      <nav class="mt-5 space-y-1 px-3">
        <button v-for="page in pages" :key="page.id" class="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium" :class="activePage === page.id ? 'bg-cyan text-ink shadow-[0_8px_24px_rgba(39,216,232,.18)]' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'" @click="setPage(page.id)">
          <component :is="page.icon" :size="17" /><span>{{ page.label }}</span><ChevronRight v-if="activePage === page.id" class="ml-auto" :size="14" />
        </button>
      </nav>
      <div class="mt-auto border-t border-line p-4">
        <div class="flex items-center gap-3 rounded-lg bg-white/[.03] p-3"><div class="grid h-9 w-9 place-items-center rounded-full bg-slate-700 text-xs font-bold">FA</div><div><div class="text-xs font-semibold text-white">FloodSense Admin</div><div class="text-[10px] text-slate-500">System oversight</div></div></div>
      </div>
    </aside>

    <div :class="activePage !== 'public' && 'lg:pl-64'">
      <header v-if="activePage !== 'public'" class="sticky top-0 z-40 flex h-16 items-center border-b border-line bg-ink/90 px-4 backdrop-blur-xl lg:px-7">
        <button class="mr-3 lg:hidden" aria-label="Buka menu" @click="mobileNav = true"><Menu :size="21" /></button>
        <div><div class="eyebrow">Operations / {{ pageTitle }}</div><div class="text-sm font-semibold text-white">Real-time River Monitoring</div></div>
        <div class="ml-auto flex items-center gap-2">
          <label class="hidden h-9 items-center gap-2 rounded-lg border border-line bg-panel px-3 md:flex"><Search :size="14" class="text-slate-500" /><input class="w-44 bg-transparent text-xs outline-none placeholder:text-slate-600" placeholder="Search nodes, alerts..." /></label>
          <a href="#public" class="rounded-lg border border-cyan/25 bg-cyan/10 px-3 py-2 text-xs font-semibold text-cyan">Public View</a>
        </div>
      </header>

      <main class="p-4 lg:p-7">
        <template v-if="activePage === 'dashboard'">
          <div class="mb-6 flex flex-wrap items-end justify-between gap-3"><div><h1 class="text-2xl font-semibold tracking-tight text-white">System Overview</h1><p class="mt-1 text-xs text-slate-500">Real-time telemetry and network status across river sectors.</p></div><div class="flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-semibold" :class="connected ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-400' : 'border-amber-400/25 bg-amber-400/10 text-amber-300'"><span class="status-dot" :class="connected ? 'bg-emerald-400 text-emerald-400' : 'bg-amber-300 text-amber-300'"></span>{{ connected ? 'LIVE DATA' : 'DEMO DATA' }}</div></div>

          <section class="grid gap-4 md:grid-cols-3">
            <button v-for="node in nodes" :key="node.sensor_id" class="card group p-4 text-left hover:border-slate-600" :class="selectedId === node.sensor_id && 'ring-1 ring-cyan/40'" @click="selectedId = node.sensor_id">
              <div class="flex items-center justify-between"><div class="eyebrow">{{ node.lokasi }} · {{ node.station_name || 'Riverstream' }}</div><Radio :size="15" :style="{ color: statusColor(node.risk_status) }" /></div>
              <div class="mt-5 flex items-end justify-between"><div><span class="text-3xl font-semibold text-white">{{ Number(node.water_level_cm).toFixed(1) }}</span><span class="ml-1 text-sm text-slate-500">cm</span></div><span class="rounded border px-2 py-1 text-[9px] font-bold uppercase" :class="statusClass(node.risk_status)">{{ node.risk_status }}</span></div>
              <div class="mt-3 flex items-center justify-between border-t border-line pt-3 text-[10px] text-slate-500"><span>Flow {{ Number(node.flow_rate).toFixed(1) }} m³/s</span><span>{{ timeLabel(node.timestamp) }}</span></div>
            </button>
          </section>

          <section class="mt-4 grid gap-4 xl:grid-cols-[1fr_300px]">
            <div class="card min-h-[330px] p-5"><div class="flex items-center justify-between"><div><div class="eyebrow">Live Water Level History</div><div class="mt-1 text-xs text-slate-500">Hulu · Tengah · Hilir</div></div><Activity :size="17" class="text-cyan" /></div><div class="mt-5 h-60 overflow-hidden rounded-lg bg-[#07111f]"><TelemetryChart :readings="readings" :nodes="nodes" /></div></div>
            <div class="card p-5"><div class="flex items-center justify-between"><div class="eyebrow">Node Focus · {{ selectedNode.lokasi }}</div><span class="rounded border px-2 py-1 text-[9px] font-bold uppercase" :class="statusClass(selectedNode.risk_status)">{{ selectedNode.risk_status }}</span></div><div class="my-5 flex items-end justify-between"><div><div class="text-[10px] uppercase tracking-wider text-slate-500">Current level</div><div class="mt-1 text-3xl font-semibold text-white">{{ Number(selectedNode.water_level_cm).toFixed(1) }}<span class="ml-1 text-sm text-slate-500">cm</span></div></div><Droplets :size="30" class="text-cyan" /></div><dl class="space-y-3 text-xs"><div class="flex justify-between border-b border-line pb-2"><dt class="text-slate-500">Danger threshold</dt><dd class="text-slate-200">{{ thresholds.danger_cm }} cm</dd></div><div class="flex justify-between border-b border-line pb-2"><dt class="text-slate-500">Flow rate</dt><dd class="text-slate-200">{{ Number(selectedNode.flow_rate).toFixed(1) }} m³/s</dd></div><div class="flex justify-between border-b border-line pb-2"><dt class="text-slate-500">Sensor health</dt><dd class="text-emerald-400">98%</dd></div><div class="flex justify-between"><dt class="text-slate-500">Last sync</dt><dd class="text-slate-200">{{ timeLabel(selectedNode.timestamp) }}</dd></div></dl></div>
          </section>

          <section class="card mt-4 overflow-hidden"><div class="flex items-center justify-between border-b border-line px-5 py-4"><div><div class="eyebrow">Latest Telemetry</div><div class="mt-1 text-xs text-slate-500">Pembacaan sensor terbaru</div></div><button class="flex items-center gap-2 text-[10px] font-semibold text-cyan" type="button" @click="exportReport"><Download :size="13" /> Export CSV</button></div><div class="overflow-x-auto"><table class="w-full min-w-[700px] text-left text-xs"><thead class="bg-white/[.02] text-[9px] uppercase tracking-widest text-slate-500"><tr><th class="px-5 py-3">Timestamp</th><th class="px-5 py-3">Node ID</th><th class="px-5 py-3">Level</th><th class="px-5 py-3">Flow</th><th class="px-5 py-3">Status</th></tr></thead><tbody><tr v-for="row in (readings.length ? readings.slice(0, 7) : nodes)" :key="row.id || row.sensor_id" class="border-t border-line/70 hover:bg-white/[.02]"><td class="px-5 py-3 text-slate-500">{{ dateLabel(row.timestamp) }}</td><td class="px-5 py-3 font-mono text-slate-300">{{ row.sensor_id }}</td><td class="px-5 py-3 font-semibold text-white">{{ Number(row.water_level_cm).toFixed(1) }} cm</td><td class="px-5 py-3">{{ Number(row.flow_rate).toFixed(1) }} m³/s</td><td class="px-5 py-3"><span class="rounded border px-2 py-1 text-[9px] font-bold uppercase" :class="statusClass(row.risk_status)">{{ row.risk_status }}</span></td></tr></tbody></table></div></section>
        </template>

        <template v-else-if="activePage === 'map'">
        <div class="mb-6"><h1 class="text-2xl font-semibold text-white">River Basin Map</h1><p class="mt-1 text-xs text-slate-500">Live spatial overview backed by the official Pulau Jawa river database.</p></div><div class="card h-[calc(100vh-170px)] min-h-[560px] overflow-hidden"><RiverMap :nodes="nodes" :selected-id="selectedId" :token="mapboxToken" :api-url="apiUrl" @select="selectedId = $event" /></div>
        </template>

        <template v-else-if="activePage === 'nodes'">
          <div class="mb-6 flex items-end justify-between">
            <div><h1 class="text-2xl font-semibold text-white">Sensor Fleet Overview</h1><p class="mt-1 text-xs text-slate-500">Manage and inspect registered monitoring nodes.</p></div>
            <div class="rounded-lg border border-cyan/20 bg-cyan/10 px-3 py-2 text-[10px] font-bold text-cyan">{{ nodes.length }} ACTIVE NODES</div>
          </div>
          <div class="grid gap-4 xl:grid-cols-3">
            <article v-for="node in nodes" :key="node.sensor_id" class="card overflow-hidden">
              <div class="h-1" :style="{ background: statusColor(node.risk_status) }"></div>
              <div class="p-5">
                <div class="flex items-start justify-between"><div><div class="eyebrow">{{ node.sensor_id }} · {{ node.lokasi }}</div><h2 class="mt-1 text-lg font-semibold text-white">{{ node.station_name || `${node.lokasi} Riverstream` }}</h2><p v-if="node.river_name" class="mt-1 text-[10px] text-slate-500">{{ node.river_name }} · {{ node.province }}</p></div><Radio :style="{ color: statusColor(node.risk_status) }" /></div>
                <div class="my-6 grid grid-cols-2 gap-3"><div class="rounded-lg bg-white/[.03] p-3"><div class="eyebrow">Water level</div><div class="mt-2 text-xl font-semibold text-white">{{ Number(node.water_level_cm).toFixed(1) }} cm</div></div><div class="rounded-lg bg-white/[.03] p-3"><div class="eyebrow">Flow rate</div><div class="mt-2 text-xl font-semibold text-white">{{ Number(node.flow_rate).toFixed(1) }}</div></div></div>
                <div class="flex items-center justify-between text-xs"><span class="text-slate-500">Sensor health</span><span class="text-emerald-400">Operational · 98%</span></div><div class="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"><div class="h-full w-[98%] bg-emerald-400"></div></div><button class="mt-5 w-full rounded-lg border border-line py-2 text-xs font-semibold hover:border-cyan/30 hover:text-cyan" @click="viewNodeDetail(node)">View node detail</button>
              </div>
            </article>
          </div>
        </template>

        <template v-else-if="activePage === 'reports'">
          <div class="mb-6 flex flex-wrap items-end justify-between gap-3"><div><h1 class="text-2xl font-semibold text-white">System Analytics</h1><p class="mt-1 text-xs text-slate-500">Historical sensor trends and incident summary.</p></div><div class="flex items-center gap-2"><span class="rounded-lg border border-line bg-panel px-3 py-2 text-xs">Latest 100 readings</span><button class="rounded-lg bg-cyan px-3 py-2 text-xs font-bold text-ink" type="button" @click="exportReport">Export report</button></div></div><div class="grid gap-4 md:grid-cols-3"><div class="card p-5"><div class="eyebrow">Highest Peak Level</div><div class="mt-3 text-3xl font-semibold text-white">{{ Number(highestNode.water_level_cm).toFixed(1) }} <span class="text-sm text-slate-500">cm</span></div><div class="mt-2 text-xs text-cyan">Node {{ highestNode.lokasi }}</div></div><div class="card p-5"><div class="eyebrow">Thresholds Crossed</div><div class="mt-3 text-3xl font-semibold text-white">{{ readings.filter(r => r.risk_status !== 'Normal').length }}</div><div class="mt-2 text-xs text-amber-300">Waspada & Bahaya</div></div><div class="card p-5"><div class="eyebrow">System Reliability</div><div class="mt-3 text-3xl font-semibold text-white">99.8<span class="text-sm text-slate-500">%</span></div><div class="mt-2 text-xs text-emerald-400">All nodes transmitting</div></div></div><div class="card mt-4 p-5"><div class="flex items-center justify-between"><div class="eyebrow">Latest Water Level Readings</div><FileChartColumn :size="18" class="text-cyan" /></div><div class="mt-5 h-72"><TelemetryChart mode="bar" :readings="readings" :nodes="nodes" /></div></div>
        </template>

        <template v-else-if="activePage === 'settings'">
          <div class="mb-6"><h1 class="text-2xl font-semibold text-white">System Settings</h1><p class="mt-1 text-xs text-slate-500">Configuration overview for the FloodSense network.</p></div>
          <div class="grid gap-4 xl:grid-cols-2">
            <section class="card p-5">
              <div class="flex items-center gap-3"><SlidersHorizontal class="text-cyan" :size="20"/><div><h2 class="font-semibold text-white">Risk Thresholds</h2><p class="text-xs text-slate-500">Disimpan di PostgreSQL dan dipakai pembacaan sensor berikutnya.</p></div></div>
              <div class="mt-5 grid grid-cols-2 gap-3">
                <label class="rounded-lg bg-white/[.03] p-4"><span class="eyebrow">Waspada mulai</span><div class="mt-2 flex items-center gap-2"><input v-model.number="thresholdDraft.warning_cm" class="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-white outline-none focus:border-cyan" type="number" min="1" max="999" /><span class="text-xs text-slate-500">cm</span></div></label>
                <label class="rounded-lg bg-white/[.03] p-4"><span class="eyebrow">Bahaya mulai</span><div class="mt-2 flex items-center gap-2"><input v-model.number="thresholdDraft.danger_cm" class="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-white outline-none focus:border-cyan" type="number" min="2" max="1000" /><span class="text-xs text-slate-500">cm</span></div></label>
              </div>
              <div class="mt-3 rounded-lg border border-line bg-white/[.02] p-3 text-[11px] text-slate-400">Normal &lt; {{ thresholdDraft.warning_cm }} cm · Waspada {{ thresholdDraft.warning_cm }}–{{ thresholdDraft.danger_cm - 1 }} cm · Bahaya ≥ {{ thresholdDraft.danger_cm }} cm</div>
              <p v-if="thresholdMessage" class="mt-3 text-xs" :class="thresholdMessage.includes('tersimpan') ? 'text-emerald-400' : 'text-rose-400'">{{ thresholdMessage }}</p>
              <button class="mt-4 w-full rounded-lg bg-cyan px-3 py-2.5 text-xs font-bold text-ink disabled:cursor-not-allowed disabled:opacity-50" type="button" :disabled="thresholdSaving" @click="saveThresholds">{{ thresholdSaving ? 'Menyimpan…' : 'Simpan Threshold' }}</button>
            </section>
            <section class="card p-5"><div class="flex items-center gap-3"><Database class="text-cyan" :size="20"/><div><h2 class="font-semibold text-white">Data Pipeline</h2><p class="text-xs text-slate-500">Service connectivity</p></div></div><div class="mt-5 space-y-4 text-xs"><div class="flex items-center justify-between border-b border-line pb-3"><span class="text-slate-500">REST API</span><span class="text-emerald-400">Online · :3001</span></div><div class="flex items-center justify-between border-b border-line pb-3"><span class="text-slate-500">Realtime channel</span><span :class="connected ? 'text-emerald-400' : 'text-amber-300'">{{ connected ? 'Socket.io connected' : 'Waiting for backend' }}</span></div><div class="flex items-center justify-between border-b border-line pb-3"><span class="text-slate-500">Database</span><span class="text-cyan">PostgreSQL</span></div><div class="flex items-center justify-between"><span class="text-slate-500">Retention</span><span class="text-white">All historical readings</span></div></div></section>
          </div>
        </template>

        <template v-else-if="activePage === 'public'">
          <div class="mx-auto max-w-5xl"><div class="mb-8 flex items-center justify-between"><div class="flex items-center gap-3"><div class="grid h-10 w-10 place-items-center rounded-lg bg-cyan text-ink"><Waves :size="22" /></div><div><div class="text-xl font-bold text-white">FloodSense</div><div class="eyebrow">Public Flood Information</div></div></div><button class="text-xs text-cyan" @click="setPage('dashboard')">Admin dashboard →</button></div><section class="rounded-2xl border p-6 md:p-8" :class="statusClass(worstNode.risk_status)"><div class="flex flex-col justify-between gap-5 md:flex-row md:items-center"><div><div class="eyebrow !text-current">Current Area Status</div><h1 class="mt-2 text-4xl font-bold">{{ worstNode.risk_status }}</h1><p class="mt-2 max-w-xl text-sm text-slate-200">{{ worstNode.risk_status === 'Bahaya' ? `Risiko banjir tinggi di area ${worstNode.lokasi}. Hindari area sungai dan ikuti arahan petugas.` : worstNode.risk_status === 'Waspada' ? 'Ketinggian air meningkat. Tetap waspada dan pantau informasi terbaru.' : 'Kondisi sungai terpantau aman.' }}</p></div><ShieldAlert :size="64" /></div></section><div class="mt-5 grid gap-4 md:grid-cols-3"><div v-for="node in nodes" :key="node.sensor_id" class="card p-5"><div class="flex items-center justify-between"><span class="font-semibold text-white">{{ node.lokasi }}</span><span class="status-dot" :style="{backgroundColor:statusColor(node.risk_status), color:statusColor(node.risk_status)}"></span></div><div class="mt-4 text-2xl font-semibold text-white">{{ Number(node.water_level_cm).toFixed(1) }} cm</div><div class="mt-2 text-xs" :style="{color:statusColor(node.risk_status)}">{{ node.risk_status }}</div></div></div><div class="mt-5 text-center text-[11px] text-slate-500">Pembaruan terakhir {{ dateLabel(worstNode.timestamp) }} · Informasi simulasi untuk kebutuhan UAS</div></div>
        </template>
      </main>
    </div>
  </div>
</template>
