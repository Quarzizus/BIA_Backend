/**
 * Helpers de dominio de anomalías compartidos entre módulos.
 *
 * La fila de anomalía lleva tanto el FK interno (`meterId` -> Meter.id) como el
 * código de medidor unido (`meter.meterId`). Los consumidores de los DTO de API
 * (lista/detalle de anomalías, anomalías recientes del dashboard) necesitan el
 * código legible, con preferencia por el join y el FK como fallback. Fuente
 * única de verdad para ese mapeo — puro, sin zod, sin Prisma client.
 */

export interface AnomalyMeterCodeSource {
  meterId: string;
  meter?: { meterId: string } | null;
}

export function anomalyMeterCode(anomaly: AnomalyMeterCodeSource): string {
  return anomaly.meter?.meterId ?? anomaly.meterId;
}