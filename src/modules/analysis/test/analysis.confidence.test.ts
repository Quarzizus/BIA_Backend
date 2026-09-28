import { describe, expect, test } from "bun:test";
import {
  CONFIDENCE_EVENT_COVERED,
  CONFIDENCE_EVENT_NEUTRAL,
  CONFIDENCE_SEVERITY,
  CONFIDENCE_STAT_MAX,
  CONFIDENCE_STAT_MIN,
  CONFIDENCE_VARIATION_MAX,
  CONFIDENCE_VARIATION_MIN,
  computeAnomalyConfidence,
} from "../analysis.domain";

/**
 * Unit — computeAnomalyConfidence (score de fuerza de evidencia).
 *
 * Fórmula: clamp(0, 1, round((statistical + variation + event + severity) / 100, 2))
 *  - statistical (40): |max_z| — ≤ 3 → 12, ≥ 10 → 40, lineal (pendiente 4 por
 *    unidad de z). Si max_z es null (p. ej. DATA_QUALITY): max(voltage_sd_ratio,
 *    power_factor_sd_ratio) — ≤ 5 → 12, ≥ 10 → 40, lineal (pendiente 5.6); si
 *    tampoco hay → 12.
 *  - variation (20): |variation_pct| — ≤ 5 % → 4, ≥ 100 % → 20, lineal.
 *  - event (20): evento de cobertura → 20; sin cobertura → 10 (neutral).
 *  - severity (20): HIGH → 20, MEDIUM → 14, LOW → 10.
 *
 * Los fixtures siguen las formas ground-truth del dataset (M-109-like,
 * FALSE_POSITIVE con evento, DATA_QUALITY con sd_ratio).
 */
function score(opts: {
  severity: "HIGH" | "MEDIUM" | "LOW";
  signals: unknown;
  eventCovered: boolean;
}): number {
  return computeAnomalyConfidence(opts);
}

describe("computeAnomalyConfidence — fixtures ground-truth", () => {
  test("un evento UNKNOWN en el rango NO cuenta como cobertura explicativa (M-109 real)", () => {
    // M-109: HIGH, max_z 9.731, variación 168.9, evento UNKNOWN dentro del rango.
    // El evento no explica (por eso es REAL_ANOMALY) → componente event = neutro (10).
    const score = computeAnomalyConfidence({
      severity: "HIGH",
      signals: { max_z: 9.731, variation_pct: 168.9, voltage_sd_ratio: 0, power_factor_sd_ratio: 0 },
      eventCovered: false,
    });
    expect(score).toBe(0.89); // 38.92 + 20 + 10 + 20 = 88.92 → 0.89
  });

  test("M-109-like (HIGH, max_z 9.7, variación 112 %, sin evento) → 0.89", () => {
    // statistical 38.8 (12 + 6.7×4) + variation 20 (112 ≥ 100) + event 10 + severity 20
    // = 88.8 pts → 0.888 → 0.89.
    expect(
      score({
        severity: "HIGH",
        signals: { max_z: 9.7, variation_pct: 112 },
        eventCovered: false,
      }),
    ).toBe(0.89);
  });

  test("FALSE_POSITIVE con evento exacto (LOW, z 5.09, variación −86.9 %, evento) → 0.68", () => {
    // statistical 20.36 (12 + 2.09×4) + variation 17.79 (4 + 81.9×16/95) + event 20
    // + severity 10 = 68.15 pts → 0.68. La variación negativa usa |variation_pct|.
    expect(
      score({
        severity: "LOW",
        signals: { max_z: 5.09, variation_pct: -86.9 },
        eventCovered: true,
      }),
    ).toBe(0.68);
  });

  test("DATA_QUALITY (HIGH, max_z null, sd_ratio 9.6, variación ≈0, evento) → 0.82", () => {
    // max_z null → fallback al MAYOR sd_ratio (9.6): statistical 37.76 (12 + 4.6×5.6)
    // + variation 4 (≤ 5 %) + event 20 + severity 20 = 81.76 pts → 0.82.
    expect(
      score({
        severity: "HIGH",
        signals: {
          max_z: null,
          variation_pct: 0.5,
          voltage_sd_ratio: 9.5,
          power_factor_sd_ratio: 9.6,
        },
        eventCovered: true,
      }),
    ).toBe(0.82);
  });
});

describe("computeAnomalyConfidence — componentes", () => {
  test("boundary estadístico: |max_z| = 3 → mínimo 12; |max_z| = 10 → tope 40", () => {
    // z = 3: 12 + 4 + 10 + 10 = 36 → 0.36 (stat floor).
    expect(score({ severity: "LOW", signals: { max_z: 3, variation_pct: 5 }, eventCovered: false })).toBe(0.36);
    // z = 0 (o menor) satura al mismo mínimo: la evidencia no baja de 12 pts.
    expect(score({ severity: "LOW", signals: { max_z: 0, variation_pct: 5 }, eventCovered: false })).toBe(0.36);
    // z = 10: 40 + 4 + 10 + 20 = 74 → 0.74.
    expect(score({ severity: "HIGH", signals: { max_z: 10, variation_pct: 5 }, eventCovered: false })).toBe(0.74);
    // z = 100 satura al tope (40) — no sigue creciendo.
    expect(score({ severity: "HIGH", signals: { max_z: 100, variation_pct: 5 }, eventCovered: false })).toBe(0.74);
  });

  test("boundary variación: |variation_pct| = 5 → 4; = 100 → 20", () => {
    // HIGH, z=3 (12): var 4 → 12+4+10+20 = 46 → 0.46.
    expect(score({ severity: "HIGH", signals: { max_z: 3, variation_pct: 5 }, eventCovered: false })).toBe(0.46);
    // var 20 → 12+20+10+20 = 62 → 0.62.
    expect(score({ severity: "HIGH", signals: { max_z: 3, variation_pct: 100 }, eventCovered: false })).toBe(0.62);
    // var 1000 satura al tope (20).
    expect(score({ severity: "HIGH", signals: { max_z: 3, variation_pct: 1000 }, eventCovered: false })).toBe(0.62);
  });

  test("evento: cobertura exacta → 20 pts; sin cobertura → 10 (neutral)", () => {
    // Único cambio: eventCovered. HIGH, z=3, var 5 %: sin evento 0.46, con evento 0.56.
    expect(
      score({ severity: "HIGH", signals: { max_z: 3, variation_pct: 5 }, eventCovered: false }),
    ).toBe(0.46);
    expect(
      score({ severity: "HIGH", signals: { max_z: 3, variation_pct: 5 }, eventCovered: true }),
    ).toBe(0.56);
    expect(CONFIDENCE_EVENT_COVERED - CONFIDENCE_EVENT_NEUTRAL).toBe(10);
  });

  test("severidad: HIGH 20, MEDIUM 14, LOW 10", () => {
    expect(CONFIDENCE_SEVERITY.HIGH).toBe(20);
    expect(CONFIDENCE_SEVERITY.MEDIUM).toBe(14);
    expect(CONFIDENCE_SEVERITY.LOW).toBe(10);
    // Misma evidencia, distinta severidad: LOW 0.36 → MEDIUM 0.40 → HIGH 0.46.
    const signals = { max_z: 3, variation_pct: 5 };
    expect(score({ severity: "LOW", signals, eventCovered: false })).toBe(0.36);
    expect(score({ severity: "MEDIUM", signals, eventCovered: false })).toBe(0.40);
    expect(score({ severity: "HIGH", signals, eventCovered: false })).toBe(0.46);
  });
});

describe("computeAnomalyConfidence — defensivo y clamp", () => {
  test("señales nulas → statistical 12 (fallback) y variation 4", () => {
    // 12 + 4 + 10 + 20 = 46 → 0.46 con signals null, {} o malformadas.
    expect(score({ severity: "HIGH", signals: null, eventCovered: false })).toBe(0.46);
    expect(score({ severity: "HIGH", signals: {}, eventCovered: false })).toBe(0.46);
    expect(
      score({
        severity: "HIGH",
        signals: { max_z: "9.7", variation_pct: "x", voltage_sd_ratio: Number.NaN },
        eventCovered: false,
      }),
    ).toBe(0.46);
    expect(
      score({ severity: "HIGH", signals: { max_z: null, variation_pct: null }, eventCovered: false }),
    ).toBe(0.46);
    // Infinity tampoco es una señal válida.
    expect(
      score({ severity: "HIGH", signals: { max_z: Number.POSITIVE_INFINITY }, eventCovered: false }),
    ).toBe(0.46);
  });

  test("max_z tiene precedencia sobre el sd_ratio cuando ambos existen", () => {
    // max_z 3 → stat 12 aunque sd_ratio 10 daría 40: 12+4+10+20 = 46 → 0.46.
    expect(
      score({
        severity: "HIGH",
        signals: { max_z: 3, voltage_sd_ratio: 10, variation_pct: 5 },
        eventCovered: false,
      }),
    ).toBe(0.46);
  });

  test("fallback DQ usa el MAYOR de los sd_ratio; satura en 10", () => {
    // max(5.1, 9.8) = 9.8 → 12 + 4.8×5.6 = 38.88 → 38.88+4+20+20 = 82.88 → 0.83.
    expect(
      score({
        severity: "HIGH",
        signals: { max_z: null, voltage_sd_ratio: 5.1, power_factor_sd_ratio: 9.8, variation_pct: 0 },
        eventCovered: true,
      }),
    ).toBe(0.83);
    // sd_ratio ≥ 10 satura a 40: 40+4+20+20 = 84 → 0.84.
    expect(
      score({
        severity: "HIGH",
        signals: { max_z: null, voltage_sd_ratio: 10, variation_pct: 0 },
        eventCovered: true,
      }),
    ).toBe(0.84);
    // sd_ratio ≤ 5 → mínimo 12: 12+4+20+20 = 56 → 0.56.
    expect(
      score({
        severity: "HIGH",
        signals: { max_z: null, voltage_sd_ratio: 4, variation_pct: 0 },
        eventCovered: true,
      }),
    ).toBe(0.56);
  });

  test("clamp superior: el score nunca supera 1", () => {
    // 40 + 20 + 20 + 20 = 100 → 1.0; valores extremos saturan igual.
    expect(
      score({
        severity: "HIGH",
        signals: { max_z: 10, variation_pct: 100 },
        eventCovered: true,
      }),
    ).toBe(1);
    expect(
      score({
        severity: "HIGH",
        signals: { max_z: 1000, variation_pct: 10000 },
        eventCovered: true,
      }),
    ).toBe(1);
  });

  test("redondeo a 2 decimales (tanto por defecto como por exceso)", () => {
    // 88.4 pts → 0.884 → 0.88.
    expect(
      score({ severity: "HIGH", signals: { max_z: 9.6, variation_pct: 100 }, eventCovered: false }),
    ).toBe(0.88);
    // 88.5 pts → 0.885 → 0.89 (redondeo del tercer decimal).
    expect(
      score({ severity: "HIGH", signals: { max_z: 9.625, variation_pct: 100 }, eventCovered: false }),
    ).toBe(0.89);
    // Los máximos por componente suman exactamente 100 pts → 1.0.
    expect(CONFIDENCE_STAT_MAX + CONFIDENCE_VARIATION_MAX + CONFIDENCE_EVENT_COVERED + CONFIDENCE_SEVERITY.HIGH).toBe(100);
    expect(CONFIDENCE_STAT_MIN + CONFIDENCE_VARIATION_MIN + CONFIDENCE_EVENT_NEUTRAL + CONFIDENCE_SEVERITY.LOW).toBe(36);
  });
});