import { describe, expect, test } from "bun:test";
import { deriveMeterStatus } from "./meter-status";

describe("deriveMeterStatus (design D4)", () => {
  test("maps a single HIGH severity to CRITICAL", () => {
    expect(deriveMeterStatus(["HIGH"])).toBe("CRITICAL");
  });

  test("maps a single MEDIUM severity to ALERT", () => {
    expect(deriveMeterStatus(["MEDIUM"])).toBe("ALERT");
  });

  test("maps a single LOW severity to NORMAL", () => {
    expect(deriveMeterStatus(["LOW"])).toBe("NORMAL");
  });

  test("maps no active anomalies to NORMAL", () => {
    expect(deriveMeterStatus([])).toBe("NORMAL");
  });

  test("most severe open anomaly wins: HIGH overrides MEDIUM", () => {
    expect(deriveMeterStatus(["MEDIUM", "HIGH"])).toBe("CRITICAL");
  });

  test("most severe open anomaly wins: MEDIUM overrides LOW", () => {
    expect(deriveMeterStatus(["LOW", "MEDIUM"])).toBe("ALERT");
  });

  test("most severe open anomaly wins regardless of order: HIGH overrides LOW", () => {
    expect(deriveMeterStatus(["LOW", "HIGH"])).toBe("CRITICAL");
  });
});