export function calculateRisk(waterLevelCm, thresholds = { warning_cm: 120, danger_cm: 180 }) {
  if (waterLevelCm >= thresholds.danger_cm) return "Bahaya";
  if (waterLevelCm >= thresholds.warning_cm) return "Waspada";
  return "Normal";
}
