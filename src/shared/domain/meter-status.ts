import type { MeterStatus } from "../../generated/prisma/enums";

/**
 * Design D4: a meter's status reflects the most severe ACTIVE (not RESOLVED)
 * anomaly: HIGH -> CRITICAL, MEDIUM -> ALERT, otherwise NORMAL.
 *
 * Single source of truth for the derivation. Reused by analysis run
 * completion (analysis.repository) and anomaly PATCH transitions
 * (anomalies/service) so the rule lives in exactly one place.
 */
export function deriveMeterStatus(activeSeverities: readonly string[]): MeterStatus {
  if (activeSeverities.includes("HIGH")) return "CRITICAL";
  if (activeSeverities.includes("MEDIUM")) return "ALERT";
  return "NORMAL";
}