<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { init, use } from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

use([BarChart, LineChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

const props = defineProps({
  mode: { type: String, default: "line" },
  readings: { type: Array, required: true },
  nodes: { type: Array, required: true },
});

const container = ref(null);
let chart;
let observer;

const palette = ["#34d399", "#fbbf24", "#27d8e8"];

function historyFor(node) {
  const rows = props.readings
    .filter((reading) => reading.sensor_id === node.sensor_id)
    .slice(0, 80)
    .map((reading) => [new Date(reading.timestamp).getTime(), Number(reading.water_level_cm)])
    .sort((a, b) => a[0] - b[0]);
  return rows.length ? rows : [[new Date(node.timestamp).getTime(), Number(node.water_level_cm)]];
}

function lineOption() {
  return {
    animationDuration: 450,
    color: palette,
    grid: { left: 48, right: 24, top: 42, bottom: 34 },
    legend: {
      top: 4,
      right: 6,
      textStyle: { color: "#94a3b8", fontSize: 10 },
      itemWidth: 14,
      itemHeight: 3,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#07101c",
      borderColor: "#1d2a3e",
      textStyle: { color: "#e2e8f0", fontSize: 11 },
      valueFormatter: (value) => `${Number(value).toFixed(1)} cm`,
    },
    xAxis: {
      type: "time",
      boundaryGap: false,
      axisLine: { lineStyle: { color: "#243248" } },
      axisTick: { show: false },
      axisLabel: { color: "#64748b", fontSize: 9 },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: (value) => Math.max(220, Math.ceil(value.max / 20) * 20),
      name: "cm",
      nameTextStyle: { color: "#64748b", fontSize: 9 },
      axisLabel: { color: "#64748b", fontSize: 9 },
      splitLine: { lineStyle: { color: "rgba(148,163,184,.10)" } },
    },
    series: props.nodes.map((node, index) => ({
      name: node.lokasi,
      type: "line",
      data: historyFor(node),
      smooth: 0.28,
      showSymbol: false,
      lineStyle: { width: index === 2 ? 2.5 : 1.8 },
      areaStyle: index === 2 ? { opacity: 0.08 } : undefined,
      emphasis: { focus: "series" },
      markLine: index === 0 ? {
        silent: true,
        symbol: "none",
        label: { position: "insideEndTop", fontSize: 9 },
        data: [
          { yAxis: 120, name: "Waspada", lineStyle: { color: "#fbbf24", type: "dashed", opacity: 0.55 }, label: { color: "#fbbf24" } },
          { yAxis: 180, name: "Bahaya", lineStyle: { color: "#fb7185", type: "dashed", opacity: 0.65 }, label: { color: "#fb7185" } },
        ],
      } : undefined,
    })),
  };
}

function barOption() {
  const rows = (props.readings.length ? props.readings : props.nodes).slice(0, 24).reverse();
  return {
    animationDuration: 450,
    grid: { left: 48, right: 18, top: 18, bottom: 48 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: "#07101c",
      borderColor: "#1d2a3e",
      textStyle: { color: "#e2e8f0", fontSize: 11 },
      valueFormatter: (value) => `${Number(value).toFixed(1)} cm`,
    },
    xAxis: {
      type: "category",
      data: rows.map((row) => new Date(row.timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })),
      axisLine: { lineStyle: { color: "#243248" } },
      axisTick: { show: false },
      axisLabel: { color: "#64748b", fontSize: 9, interval: 2 },
    },
    yAxis: {
      type: "value",
      name: "cm",
      nameTextStyle: { color: "#64748b", fontSize: 9 },
      axisLabel: { color: "#64748b", fontSize: 9 },
      splitLine: { lineStyle: { color: "rgba(148,163,184,.10)" } },
    },
    series: [{
      name: "Water level",
      type: "bar",
      barMaxWidth: 18,
      data: rows.map((row) => ({
        value: Number(row.water_level_cm),
        itemStyle: {
          color: row.risk_status === "Bahaya" ? "#fb7185"
            : row.risk_status === "Waspada" ? "#fbbf24" : "#27d8e8",
          borderRadius: [3, 3, 0, 0],
        },
      })),
    }],
  };
}

function render() {
  chart?.setOption(props.mode === "bar" ? barOption() : lineOption(), true);
}

onMounted(() => {
  chart = init(container.value, null, { renderer: "canvas" });
  observer = new ResizeObserver(() => chart.resize());
  observer.observe(container.value);
  render();
});

watch(() => [props.mode, props.readings, props.nodes], render, { deep: true });

onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
});
</script>

<template>
  <div ref="container" class="h-full w-full" role="img" aria-label="Grafik telemetri sensor ECharts" />
</template>
