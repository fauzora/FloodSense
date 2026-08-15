<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Maximize2, Minimize2, Settings2, X } from "lucide-vue-next";
import * as mapboxgl from "mapbox-gl/esm";
import "mapbox-gl/dist/mapbox-gl.css";

const props = defineProps({
  nodes: { type: Array, required: true },
  selectedId: { type: String, required: true },
  token: { type: String, default: "" },
  apiUrl: { type: String, required: true },
});
const emit = defineEmits(["select"]);

const container = ref(null);
const mapShell = ref(null);
const mapError = ref("");
const riverStats = ref(null);
const regions = ref([]);
const selectedRegion = ref("DKI Jakarta");
const settingsOpen = ref(false);
const showRivers = ref(true);
const showRiverLabels = ref(true);
const showSensors = ref(true);
const riverOpacity = ref(80);
const lightPreset = ref("day");
const focusArea = ref("indonesia");
const isFullscreen = ref(false);
let map;
const markers = new Map();

const INDONESIA_BOUNDS = [[94.97195, -11.00756], [141.02005, 6.07675]];
const JAVA_BOUNDS = [[104.8, -9.1], [114.8, -5.5]];

const fallbackCoordinates = {
  node_hulu_01: [106.8051, -6.5879],
  node_tengah_01: [106.8296, -6.3712],
  node_hilir_01: [106.8272, -6.1754],
};
const colors = { Normal: "#34d399", Waspada: "#fbbf24", Bahaya: "#fb7185" };

function coordinates(node) {
  return node.longitude && node.latitude
    ? [Number(node.longitude), Number(node.latitude)]
    : fallbackCoordinates[node.sensor_id];
}

function markerElement(node) {
  const element = document.createElement("button");
  element.className = "river-marker";
  element.type = "button";
  element.setAttribute("aria-label", node.station_name || `Node ${node.lokasi}`);
  element.addEventListener("click", () => emit("select", node.sensor_id));
  return element;
}

function popupHtml(node) {
  return `<div class="river-popup"><small>${node.sensor_id} · ${node.lokasi}</small><strong>${node.station_name || node.lokasi}</strong><span>${node.river_name || "Aliran sungai"}</span><span>${Number(node.water_level_cm).toFixed(1)} cm · ${node.risk_status}</span><small>Metadata pos resmi · telemetri simulasi</small></div>`;
}

function riverPopupContent(river) {
  const popup = document.createElement("div");
  popup.className = "river-popup";
  const length = Number(river.length_m);
  const riverType = Number(river.type) === 1 ? "Sungai alam"
    : Number(river.type) === 2 ? "Sungai buatan" : "Tipe tidak tercatat";
  for (const [tag, text] of [
    ["small", `RBI BIG · ${river.provinces || "Pulau Jawa"}`],
    ["strong", river.name || "Sungai tanpa nama"],
    ["span", `DAS ${river.basin || "belum tercatat"}`],
    ["span", `${riverType} · ${length ? `${(length / 1000).toFixed(2)} km` : "panjang tidak tercatat"}`],
    ["span", river.watershed ? `Wilayah Sungai ${river.watershed}` : "Wilayah sungai belum tercatat"],
  ]) {
    const element = document.createElement(tag);
    element.textContent = text;
    popup.appendChild(element);
  }
  return popup;
}

function syncNodes() {
  if (!map?.loaded()) return;

  for (const node of props.nodes) {
    const point = coordinates(node);
    if (!point) continue;
    let marker = markers.get(node.sensor_id);
    if (!marker) {
      marker = new mapboxgl.Marker({ element: markerElement(node), anchor: "center" })
        .setLngLat(point)
        .setPopup(new mapboxgl.Popup({ offset: 18, closeButton: false }).setHTML(popupHtml(node)))
        .addTo(map);
      markers.set(node.sensor_id, marker);
    }
    marker.setLngLat(point);
    marker.getPopup().setHTML(popupHtml(node));
    const element = marker.getElement();
    element.style.setProperty("--marker-color", colors[node.risk_status] || "#94a3b8");
    element.style.display = showSensors.value ? "" : "none";
    element.dataset.selected = String(node.sensor_id === props.selectedId);
  }
}

function setLayerVisibility(layerId, visible) {
  if (map?.getLayer(layerId)) {
    map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
  }
}

function applyMapSettings() {
  if (!map) return;
  map.setConfigProperty?.("basemap", "lightPreset", lightPreset.value);
  setLayerVisibility("java-rivers-line", showRivers.value);
  setLayerVisibility("java-rivers-label", showRivers.value && showRiverLabels.value);
  if (map.getLayer("java-rivers-line")) {
    map.setPaintProperty("java-rivers-line", "line-opacity", riverOpacity.value / 100);
  }
  syncNodes();
}

function riverTileUrl() {
  const province = selectedRegion.value
    ? `&province=${encodeURIComponent(selectedRegion.value)}`
    : "";
  return `${props.apiUrl}/api/rivers/tiles/{z}/{x}/{y}.mvt?v=rbi25k-4${province}`;
}

function syncRegionFilter(animate = true) {
  if (!map?.getSource("indonesia-regions")) return;
  map.getSource("java-rivers")?.setTiles([riverTileUrl()]);
  const filter = ["==", ["get", "province"], selectedRegion.value || "__none__"];
  const dimFilter = selectedRegion.value
    ? ["!=", ["get", "province"], selectedRegion.value]
    : ["==", ["get", "province"], "__none__"];
  if (map.getLayer("selected-region-fill")) map.setFilter("selected-region-fill", filter);
  if (map.getLayer("selected-region-line")) map.setFilter("selected-region-line", filter);
  if (map.getLayer("unselected-region-dim")) map.setFilter("unselected-region-dim", dimFilter);
  if (map.getLayer("province-boundaries")) {
    map.setPaintProperty("province-boundaries", "line-opacity", selectedRegion.value ? 0.16 : 0.58);
  }

  const region = regions.value.find((item) => item.name === selectedRegion.value);
  if (region) {
    const [west, south, east, north] = region.focusBounds || region.bounds;
    const bounds = [[west, south], [east, north]];
    const camera = map.cameraForBounds(bounds, { padding: 64, maxZoom: 9 });
    map.setMaxBounds(bounds);
    map.setMinZoom(Math.min(camera?.zoom || 3, 9));
    map.stop();
    map.fitBounds(bounds, { padding: 64, duration: animate ? 700 : 0, maxZoom: 9 });
  } else {
    map.setMaxBounds(INDONESIA_BOUNDS);
    map.setMinZoom(3);
    focusMap(focusArea.value, animate);
  }
}

function focusMap(area, animate = true) {
  if (!map) return;
  const bounds = area === "java" ? JAVA_BOUNDS : INDONESIA_BOUNDS;
  map.stop();
  map.fitBounds(bounds, {
    padding: area === "java" ? 56 : 32,
    duration: animate ? 900 : 0,
    maxZoom: area === "java" ? 7 : 4.7,
  });
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await mapShell.value?.requestFullscreen();
  } else {
    await document.exitFullscreen();
  }
  settingsOpen.value = false;
}

function handleFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === mapShell.value;
  window.setTimeout(() => {
    map?.resize();
    if (selectedRegion.value) syncRegionFilter(false);
    else focusMap(focusArea.value, false);
  }, 100);
}

onMounted(() => {
  if (!props.token) {
    mapError.value = "Tambahkan MAPBOX_PUBLIC_TOKEN pada file .env untuk mengaktifkan peta.";
    return;
  }

  map = new mapboxgl.Map({
    accessToken: props.token,
    container: container.value,
    style: "mapbox://styles/mapbox/standard-satellite",
    center: [118, -2.5],
    zoom: 3.8,
    minZoom: 3,
    maxBounds: INDONESIA_BOUNDS,
    renderWorldCopies: false,
    refreshExpiredTiles: false,
    maxTileCacheSize: 128,
    fadeDuration: 0,
    crossSourceCollisions: false,
    performanceMetricsCollection: false,
    pitch: 0,
    bearing: 0,
    attributionControl: true,
    config: {
      basemap: {
        lightPreset: "day",
        showPointOfInterestLabels: false,
        showRoadLabels: false,
        showRoadsAndTransit: false,
        showTransitLabels: false,
        showPlaceLabels: false,
        showPedestrianRoads: false,
        show3dObjects: false,
        showAdminBoundaries: false,
      },
    },
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
  document.addEventListener("fullscreenchange", handleFullscreenChange);

  map.on("load", async () => {
    try {
      const [statsResponse, regionsResponse] = await Promise.all([
        fetch(`${props.apiUrl}/api/rivers/stats`),
        fetch(`${props.apiUrl}/api/regions`),
      ]);
      if (!statsResponse.ok || !regionsResponse.ok) throw new Error("Data peta tidak tersedia");
      riverStats.value = (await statsResponse.json()).data;
      const regionData = (await regionsResponse.json()).data;
      regions.value = regionData.provinces.features
        .filter((feature) => regionData.filterable.includes(feature.properties.province))
        .map((feature) => ({
          name: feature.properties.province,
          bounds: feature.properties.bounds,
          focusBounds: feature.properties.focus_bounds,
        }));

      map.addSource("indonesia-mask", { type: "geojson", data: regionData.mask });
      map.addLayer({
        id: "outside-indonesia-mask",
        type: "fill",
        source: "indonesia-mask",
        slot: "top",
        paint: { "fill-color": "#020711", "fill-opacity": 0.9 },
      });
      map.addSource("indonesia-regions", {
        type: "geojson",
        data: regionData.provinces,
        tolerance: 0.5,
      });
      map.addLayer({
        id: "unselected-region-dim",
        type: "fill",
        source: "indonesia-regions",
        slot: "top",
        filter: ["==", ["get", "province"], "__none__"],
        paint: { "fill-color": "#020711", "fill-opacity": 0.76 },
      });
      map.addLayer({
        id: "selected-region-fill",
        type: "fill",
        source: "indonesia-regions",
        slot: "top",
        filter: ["==", ["get", "province"], "__none__"],
        paint: { "fill-color": "#22d3ee", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "province-boundaries",
        type: "line",
        source: "indonesia-regions",
        slot: "top",
        paint: {
          "line-color": "#e2e8f0",
          "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.5, 8, 1.2],
          "line-opacity": 0.58,
        },
      });
      map.addLayer({
        id: "selected-region-line",
        type: "line",
        source: "indonesia-regions",
        slot: "top",
        filter: ["==", ["get", "province"], "__none__"],
        paint: { "line-color": "#22d3ee", "line-width": 2.5, "line-opacity": 1 },
      });
    } catch {
      mapError.value = "Database sungai atau batas wilayah sedang tidak dapat dimuat.";
      return;
    }

    map.addSource("java-rivers", {
      type: "vector",
      tiles: [riverTileUrl()],
      minzoom: 5,
      maxzoom: 14,
      promoteId: "id",
    });
    map.addLayer({
      id: "java-rivers-line",
      type: "line",
      source: "java-rivers",
      "source-layer": "rivers",
      slot: "top",
      paint: {
        "line-color": ["match", ["get", "type"], 2, "#38bdf8", "#67e8f9"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.7, 10, 1.5, 14, 3.5],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.72, 10, 0.9],
        "line-emissive-strength": 1,
      },
    });
    map.addLayer({
      id: "java-rivers-label",
      type: "symbol",
      source: "java-rivers",
      "source-layer": "rivers",
      slot: "top",
      minzoom: 8,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 600,
        "text-field": ["get", "name"],
        "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 9, 14, 13],
        "text-letter-spacing": 0.04,
      },
      paint: {
        "text-color": "#d5fbff",
        "text-halo-color": "#06202b",
        "text-halo-width": 1.5,
        "text-halo-blur": 0.5,
      },
    });

    map.on("click", "java-rivers-line", (event) => {
      const river = event.features?.[0]?.properties;
      if (!river) return;
      new mapboxgl.Popup({ offset: 8, closeButton: false })
        .setLngLat(event.lngLat)
        .setDOMContent(riverPopupContent(river))
        .addTo(map);
    });
    map.on("mouseenter", "java-rivers-line", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "java-rivers-line", () => { map.getCanvas().style.cursor = ""; });
    applyMapSettings();
    syncRegionFilter(false);
  });
  map.on("error", (event) => {
    if (/token|unauthorized|forbidden/i.test(event.error?.message || "")) {
      mapError.value = "Token Mapbox tidak valid atau tidak memiliki izin membaca style.";
    }
  });
});

watch(() => [props.nodes, props.selectedId], syncNodes, { deep: true });
watch([showRivers, showRiverLabels, showSensors, lightPreset, riverOpacity], applyMapSettings);
watch(focusArea, (area) => focusMap(area));
watch(selectedRegion, () => syncRegionFilter());

onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  markers.clear();
  map?.remove();
});
</script>

<template>
  <div ref="mapShell" class="map-command-center relative h-full min-h-[560px] overflow-hidden rounded-xl bg-[#07131c]">
    <div ref="container" class="absolute inset-0" />
    <div v-if="mapError" class="absolute inset-0 grid place-items-center bg-[#07131c] p-8 text-center">
      <div class="max-w-md rounded-xl border border-amber-300/25 bg-amber-300/10 p-6">
        <div class="text-sm font-semibold text-amber-300">Mapbox belum aktif</div>
        <p class="mt-2 text-xs leading-5 text-slate-400">{{ mapError }}</p>
      </div>
    </div>
    <div class="absolute left-4 top-4 rounded-lg border border-line bg-ink/90 px-4 py-3 backdrop-blur">
      <div class="eyebrow">National River Database</div>
      <div class="mt-1 text-sm font-semibold text-white">Jaringan Sungai Pulau Jawa</div>
      <div class="mt-1 text-[10px] text-slate-400">
        {{ riverStats?.segments?.toLocaleString("id-ID") || "…" }} ruas ·
        {{ riverStats?.named_rivers?.toLocaleString("id-ID") || "…" }} sungai bernama
      </div>
      <div class="mt-0.5 text-[10px] text-slate-400">
        {{ riverStats?.total_length_km?.toLocaleString("id-ID") || "…" }} km geometri
      </div>
      <a
        class="mt-2 block text-[10px] font-semibold text-cyan hover:text-cyan/80"
        href="https://geoservices.big.go.id/rbi/rest/services/BASEMAP/Rupabumi_Indonesia/MapServer/566"
        target="_blank"
        rel="noreferrer"
      >Sumber: Rupabumi Indonesia · BIG ↗</a>
    </div>
    <label class="absolute right-14 top-20 z-20">
      <span class="sr-only">Filter daerah</span>
      <select
        v-model="selectedRegion"
        class="h-9 w-44 cursor-pointer rounded-lg border px-3 text-xs font-semibold shadow-lg outline-none transition"
        :class="selectedRegion ? 'border-cyan bg-cyan text-[#06202b]' : 'border-line bg-ink/95 text-slate-300 hover:border-cyan/50'"
        aria-label="Filter daerah"
      >
        <option value="">Semua daerah</option>
        <option v-for="region in regions" :key="region.name" :value="region.name">
          {{ region.name }}
        </option>
      </select>
    </label>
    <button
      class="absolute right-3 top-20 z-20 grid h-9 w-9 place-items-center rounded-lg border border-line bg-ink/90 text-slate-300 shadow-lg backdrop-blur transition hover:border-cyan/50 hover:text-cyan"
      type="button"
      aria-label="Pengaturan peta"
      title="Pengaturan peta"
      @click="settingsOpen = true"
    >
      <Settings2 :size="17" />
    </button>

    <div
      v-if="settingsOpen"
      class="absolute inset-0 z-40 grid place-items-center bg-[#020711]/75 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-settings-title"
      @click.self="settingsOpen = false"
    >
      <section class="w-full max-w-md overflow-hidden rounded-2xl border border-line bg-[#07101c] shadow-2xl">
        <header class="flex items-start justify-between border-b border-line px-5 py-4">
          <div>
            <div class="eyebrow">Command Center</div>
            <h2 id="map-settings-title" class="mt-1 text-base font-semibold text-white">Pengaturan Peta</h2>
            <p class="mt-1 text-xs text-slate-400">Atur tampilan operasional tanpa memuat ulang dashboard.</p>
          </div>
          <button class="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-white" type="button" aria-label="Tutup pengaturan" @click="settingsOpen = false">
            <X :size="18" />
          </button>
        </header>

        <div class="space-y-5 p-5">
          <div>
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Tampilan satelit</div>
            <div class="grid grid-cols-2 gap-2 rounded-xl bg-[#0b1725] p-1">
              <button
                v-for="preset in [{ value: 'day', label: 'Terang' }, { value: 'night', label: 'Malam' }]"
                :key="preset.value"
                class="rounded-lg px-3 py-2 text-xs font-semibold transition"
                :class="lightPreset === preset.value ? 'bg-cyan text-[#06202b]' : 'text-slate-400 hover:text-white'"
                type="button"
                @click="lightPreset = preset.value"
              >{{ preset.label }}</button>
            </div>
          </div>

          <div>
            <div class="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Fokus wilayah</div>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="area in [{ value: 'indonesia', label: 'Indonesia' }, { value: 'java', label: 'Pulau Jawa' }]"
                :key="area.value"
                class="rounded-lg border px-3 py-2.5 text-xs font-semibold transition"
                :class="focusArea === area.value ? 'border-cyan bg-cyan text-[#06202b]' : 'border-line text-slate-400 hover:text-white'"
                type="button"
                @click="selectedRegion = ''; focusArea = area.value"
              >{{ area.label }}</button>
            </div>
          </div>

          <div class="divide-y divide-line rounded-xl border border-line bg-[#0b1725] px-4">
            <label class="flex cursor-pointer items-center justify-between py-3.5 text-xs font-medium text-slate-300">
              Geometri sungai RBI
              <input v-model="showRivers" type="checkbox" class="map-switch" />
            </label>
            <label class="flex cursor-pointer items-center justify-between py-3.5 text-xs font-medium text-slate-300">
              Nama sungai
              <input v-model="showRiverLabels" type="checkbox" class="map-switch" :disabled="!showRivers" />
            </label>
            <label class="block py-3.5 text-xs font-medium text-slate-300">
              <span class="mb-2 flex items-center justify-between">
                Opasitas sungai
                <span class="font-mono text-cyan">{{ riverOpacity }}%</span>
              </span>
              <input
                v-model.number="riverOpacity"
                class="w-full accent-cyan disabled:opacity-40"
                type="range"
                min="20"
                max="100"
                step="5"
                :disabled="!showRivers"
              />
            </label>
            <label class="flex cursor-pointer items-center justify-between py-3.5 text-xs font-medium text-slate-300">
              Node sensor
              <input v-model="showSensors" type="checkbox" class="map-switch" />
            </label>
          </div>

          <button
            class="flex w-full items-center justify-center gap-2 rounded-xl bg-cyan px-4 py-3 text-xs font-bold text-[#06202b] transition hover:bg-cyan/90"
            type="button"
            @click="toggleFullscreen"
          >
            <Minimize2 v-if="isFullscreen" :size="17" />
            <Maximize2 v-else :size="17" />
            {{ isFullscreen ? "Keluar Fullscreen" : "Buka Fullscreen Command Center" }}
          </button>
        </div>
      </section>
    </div>

    <div class="pointer-events-none absolute bottom-5 left-5 flex gap-4 rounded-lg border border-line bg-ink/90 px-4 py-3 text-[10px] backdrop-blur">
      <span class="flex items-center gap-2"><i class="h-0.5 w-5 bg-cyan" />Sungai RBI</span>
      <span v-for="(color, status) in colors" :key="status" class="flex items-center gap-2">
        <i class="h-2 w-2 rounded-full" :style="{ backgroundColor: color }" />{{ status }}
      </span>
    </div>
  </div>
</template>

<style>
.mapboxgl-map { font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.mapboxgl-ctrl-group { overflow: hidden; border: 1px solid #1d2a3e; background: #07101c; }
.mapboxgl-ctrl-group button + button { border-top-color: #1d2a3e; }
.mapboxgl-ctrl-icon { filter: invert(1); opacity: .75; }
.mapboxgl-popup-content { border: 1px solid #1d2a3e; border-radius: 10px; background: #07101c; color: #e2e8f0; box-shadow: 0 18px 50px rgba(0,0,0,.45); }
.mapboxgl-popup-tip { border-top-color: #07101c !important; }
.river-popup { display: grid; gap: 3px; min-width: 130px; }
.river-popup small { color: #64748b; font-size: 9px; text-transform: uppercase; letter-spacing: .1em; }
.river-popup strong { color: white; }
.river-popup span { color: #94a3b8; font-size: 11px; }
.river-marker { width: 18px; height: 18px; padding: 0; border: 4px solid #07101c; border-radius: 999px; background: var(--marker-color); box-shadow: 0 0 18px var(--marker-color); cursor: pointer; }
.river-marker[data-selected="true"] { width: 24px; height: 24px; outline: 2px solid var(--marker-color); outline-offset: 3px; }
.map-command-center:fullscreen { min-height: 100vh; border-radius: 0; }
.map-switch { width: 34px; height: 18px; cursor: pointer; accent-color: #67e8f9; }
.map-switch:disabled { cursor: not-allowed; opacity: .4; }
</style>
