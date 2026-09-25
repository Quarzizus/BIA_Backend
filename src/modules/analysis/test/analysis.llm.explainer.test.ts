import { describe, expect, test } from "bun:test";
import { buildExplainPrompt, parseExplanation } from "../llm/analysis.llm.explainer";

const anomaly = {
  meterId: "M-109",
  type: "REAL_ANOMALY",
  severity: "HIGH",
  detectionType: "SPIKE,PERSISTENT_CHANGE",
  signals: {
    max_z: 8.79,
    variation_pct: 152.5,
    variables: ["consumption_kwh", "current_a", "power_factor"],
    per_variable: {
      consumption_kwh: {
        baseline_mean: 43.7,
        recent_mean: 92.8,
        variation_pct: 112.3,
        max_z: 9.73,
      },
    },
  },
  rangeStart: "2026-09-12T14:00:00.000Z",
  rangeEnd: "2026-09-14T23:00:00.000Z",
};

describe("buildExplainPrompt", () => {
  test("returns a Spanish system prompt and a user message embedding the anomaly", () => {
    const messages = buildExplainPrompt(anomaly);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("español");
    expect(messages[1]!.content).toContain("M-109");
    expect(messages[1]!.content).toContain("REAL_ANOMALY");
    expect(messages[1]!.content).toContain("SPIKE,PERSISTENT_CHANGE");
    expect(messages[1]!.content).toContain('"max_z": 8.79');
  });

  test("instructs the explanation format (paragraphs + markdown bullets) in system and user messages", () => {
    const messages = buildExplainPrompt(anomaly);
    // Sistema: contrato de formato para reason/recommended_action.
    expect(messages[0]!.content).toContain("párrafos");
    expect(messages[0]!.content).toContain("- ");
    // Prompt del usuario: los mismos requisitos embebidos explícitamente.
    expect(messages[1]!.content).toContain("párrafos");
    expect(messages[1]!.content).toContain('"- "');
    expect(messages[1]!.content).toContain("markdown");
  });

  test("embeds readable per-variable evidence lines (baseline → reciente)", () => {
    const messages = buildExplainPrompt(anomaly);
    expect(messages[1]!.content).toContain("Evidencia por variable (baseline → reciente):");
    expect(messages[1]!.content).toContain(
      "consumption_kwh: baseline 43.7 → reciente 92.8 (+112.3%), max_z 9.7",
    );
  });

  test("omits the evidence section when per_variable is absent", () => {
    const messages = buildExplainPrompt({ ...anomaly, signals: { max_z: 8.79 } });
    expect(messages[1]!.content).not.toContain("Evidencia por variable");
  });
});

describe("parseExplanation", () => {
  test("parses a valid Spanish reason/action object", () => {
    const parsed = parseExplanation(
      JSON.stringify({
        reason: "Consumo muy por encima de la línea base durante un periodo sostenido.",
        recommended_action: "Revisar la instalación eléctrica del medidor.",
      }),
    );
    expect(parsed.reason).toContain("línea base");
    expect(parsed.recommended_action).toContain("medidor");
  });

  test("throws on malformed JSON", () => {
    expect(() => parseExplanation("not-json")).toThrow();
  });

  test("throws when required fields are missing", () => {
    expect(() => parseExplanation(JSON.stringify({ reason: "solo razón" }))).toThrow();
  });

  test("throws when fields are empty strings", () => {
    expect(() =>
      parseExplanation(JSON.stringify({ reason: "", recommended_action: "" })),
    ).toThrow();
  });
});