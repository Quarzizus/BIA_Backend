/**
 * Anomaly domain helpers shared across modules.
 *
 * The anomaly row carries both the internal FK (`meterId` -> Meter.id) and the
 * joined meter code (`meter.meterId`). Consumers of the API DTOs (anomalies
 * list/detail, dashboard recent anomalies) need the human-readable code, with
 * the join preferred and the FK as fallback. Single source of truth for that
 * mapping — pure, no zod, no Prisma client.
 */

export interface AnomalyMeterCodeSource {
  meterId: string;
  meter?: { meterId: string } | null;
}

/** Meter code for an anomaly row: prefer the joined meter, fall back to the FK. */
export function anomalyMeterCode(anomaly: AnomalyMeterCodeSource): string {
  return anomaly.meter?.meterId ?? anomaly.meterId;
}