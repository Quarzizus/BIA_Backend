import { describe, expect, test } from "bun:test";
import {
  classifyAnomaly,
  nearMissWindowMs,
  type ClassifyInput,
} from "../stages/analysis.classifier";

const input = (overrides: Partial<ClassifyInput> = {}): ClassifyInput => ({
  detectionType: "SPIKE",
  rangeStart: new Date("2026-09-12T14:00:00.000Z"),
  rangeEnd: new Date("2026-09-14T23:00:00.000Z"),
  maxZ: 8.79,
  events: [],
  ...overrides,
});

describe("classifyAnomaly — event coverage matrix", () => {
  test("SCHEDULED_OUTAGE covering the range → FALSE_POSITIVE/LOW (M-106)", () => {
    const result = classifyAnomaly(
      input({
        rangeStart: new Date("2026-09-08T00:00:00.000Z"),
        rangeEnd: new Date("2026-09-08T11:00:00.000Z"),
        events: [
          {
            eventTimestamp: new Date("2026-09-08T00:00:00.000Z"),
            eventType: "SCHEDULED_OUTAGE",
          },
        ],
      }),
    );
    expect(result).toEqual({
      type: "FALSE_POSITIVE",
      severity: "LOW",
      needsLlm: false,
      coveringEvent: "SCHEDULED_OUTAGE",
    });
  });

  test("OPERATIONAL_CHANGE covering the range → EXPLAINABLE_ANOMALY/MEDIUM (M-104)", () => {
    const result = classifyAnomaly(
      input({
        detectionType: "PERSISTENT_CHANGE",
        rangeStart: new Date("2026-09-11T00:00:00.000Z"),
        rangeEnd: new Date("2026-09-14T23:00:00.000Z"),
        events: [
          {
            eventTimestamp: new Date("2026-09-11T00:00:00.000Z"),
            eventType: "OPERATIONAL_CHANGE",
          },
        ],
      }),
    );
    expect(result).toEqual({
      type: "EXPLAINABLE_ANOMALY",
      severity: "MEDIUM",
      needsLlm: false,
      coveringEvent: "OPERATIONAL_CHANGE",
    });
  });

  test("UNKNOWN event covering the range → REAL_ANOMALY/HIGH (M-109)", () => {
    const result = classifyAnomaly(
      input({
        events: [
          {
            eventTimestamp: new Date("2026-09-12T14:00:00.000Z"),
            eventType: "UNKNOWN",
          },
        ],
      }),
    );
    expect(result).toEqual({
      type: "REAL_ANOMALY",
      severity: "HIGH",
      needsLlm: false,
      coveringEvent: "UNKNOWN",
    });
  });

  test("DATA_QUALITY detection has priority → DATA_QUALITY/HIGH regardless of event (M-112)", () => {
    const result = classifyAnomaly(
      input({
        detectionType: "DATA_QUALITY",
        rangeStart: new Date("2026-09-13T00:00:00.000Z"),
        rangeEnd: new Date("2026-09-14T23:00:00.000Z"),
        events: [
          {
            eventTimestamp: new Date("2026-09-13T00:00:00.000Z"),
            eventType: "DATA_QUALITY",
          },
        ],
      }),
    );
    expect(result).toEqual({
      type: "DATA_QUALITY",
      severity: "HIGH",
      needsLlm: false,
      coveringEvent: "DATA_QUALITY",
    });
  });

  test("no covering event → REAL_ANOMALY/HIGH", () => {
    const result = classifyAnomaly(input({ events: [] }));
    expect(result).toEqual({
      type: "REAL_ANOMALY",
      severity: "HIGH",
      needsLlm: false,
      coveringEvent: null,
    });
  });
});

describe("classifyAnomaly — LLM borderline routing", () => {
  test("2.5 <= maxZ < 3 → needsLlm (synthetic borderline)", () => {
    const result = classifyAnomaly(input({ maxZ: 2.8 }));
    expect(result.needsLlm).toBe(true);
    expect(result.coveringEvent).toBeNull();
  });

  test("maxZ < 2.5 without event → REAL_ANOMALY/HIGH rule-based (not borderline)", () => {
    const result = classifyAnomaly(input({ maxZ: 2.2, events: [] }));
    expect(result.needsLlm).toBe(false);
    expect(result.type).toBe("REAL_ANOMALY");
  });

  test("maxZ >= 3 → rule-based, no LLM", () => {
    const result = classifyAnomaly(input({ maxZ: 5.09 }));
    expect(result.needsLlm).toBe(false);
  });

  test("near-miss event within ±6h of the range but outside → needsLlm", () => {
    const result = classifyAnomaly(
      input({
        rangeStart: new Date("2026-09-12T14:00:00.000Z"),
        rangeEnd: new Date("2026-09-14T23:00:00.000Z"),
        events: [
          {
            eventTimestamp: new Date("2026-09-12T08:00:00.000Z"), // 6h before range start
            eventType: "OPERATIONAL_CHANGE",
          },
        ],
      }),
    );
    expect(result.needsLlm).toBe(true);
    expect(result.coveringEvent).toBeNull();
  });

  test("near-miss window constant is 6h", () => {
    expect(nearMissWindowMs).toBe(6 * 60 * 60 * 1000);
  });

  test("event well outside ±6h → not near-miss, rule-based", () => {
    const result = classifyAnomaly(
      input({
        rangeStart: new Date("2026-09-12T14:00:00.000Z"),
        rangeEnd: new Date("2026-09-14T23:00:00.000Z"),
        events: [
          {
            eventTimestamp: new Date("2026-09-10T00:00:00.000Z"),
            eventType: "OPERATIONAL_CHANGE",
          },
        ],
      }),
    );
    expect(result.needsLlm).toBe(false);
    expect(result.type).toBe("REAL_ANOMALY");
  });
});