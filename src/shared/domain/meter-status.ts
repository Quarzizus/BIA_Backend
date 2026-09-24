import type { MeterStatus } from "../../generated/prisma/enums";

/**
 * Diseño D4: el status de un medidor refleja la anomalía ACTIVE (no RESOLVED)
 * más severa: HIGH -> CRITICAL, MEDIUM -> ALERT, si no NORMAL.
 *
 * Fuente única de verdad para la derivación. La reutilizan la finalización de
 * runs de análisis (analysis.repository) y las transiciones PATCH de anomalías
 * (anomalies/service) para que la regla viva en un solo lugar.
 */
export function deriveMeterStatus(activeSeverities: readonly string[]): MeterStatus {
  if (activeSeverities.includes("HIGH")) return "CRITICAL";
  if (activeSeverities.includes("MEDIUM")) return "ALERT";
  return "NORMAL";
}