import { describe, expect, test } from "bun:test";
import { canTransition } from "../anomaly.transition";

describe("canTransition", () => {
  test("allows OPEN to INVESTIGATING", () => {
    expect(canTransition("OPEN", "INVESTIGATING")).toBe(true);
  });

  test("allows INVESTIGATING to RESOLVED", () => {
    expect(canTransition("INVESTIGATING", "RESOLVED")).toBe(true);
  });

  test("rejects OPEN to RESOLVED (skipped state)", () => {
    expect(canTransition("OPEN", "RESOLVED")).toBe(false);
  });

  test("rejects RESOLVED to OPEN (backwards)", () => {
    expect(canTransition("RESOLVED", "OPEN")).toBe(false);
  });

  test("rejects same-state transitions", () => {
    expect(canTransition("OPEN", "OPEN")).toBe(false);
  });

  test("rejects transitions out of RESOLVED", () => {
    expect(canTransition("RESOLVED", "INVESTIGATING")).toBe(false);
  });
});