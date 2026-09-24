/**
 * Constantes de tiempo compartidas (ms) usadas por varios módulos. Fuente única
 * de verdad — antes se redeclaraban en detector, meter.repository y baselines
 * inline.
 */

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;