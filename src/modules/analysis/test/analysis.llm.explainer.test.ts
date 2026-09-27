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
  related_event: null,
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

  test("instructs the simple versions (cotidiano, sin jerga, idea principal y 2-3 pasos)", () => {
    const messages = buildExplainPrompt(anomaly);
    // Sistema: contrato dual para reason_simple/recommended_action_simple.
    expect(messages[0]!.content).toContain("reason_simple");
    expect(messages[0]!.content).toContain("COTIDIANO");
    expect(messages[0]!.content).toContain("analogía");
    // Prompt del usuario: reglas de formato simple.
    expect(messages[1]!.content).toContain("reason_simple");
    expect(messages[1]!.content).toContain('"Idea principal: "');
    expect(messages[1]!.content).toContain("UNA frase corta");
    expect(messages[1]!.content).toContain("cualquier persona pueda seguir");
  });

  test("embeds the few-shot example with the exact desired format", () => {
    const messages = buildExplainPrompt(anomaly);
    // Ejemplo few-shot en el prompt del usuario para que el modelo imite el formato.
    expect(messages[1]!.content).toContain("IMITA EXACTAMENTE");
    expect(messages[1]!.content).toContain(
      "El consumo pasó de 43.7 a 92.8 kWh/h (+112.3%), con un pico de |z| 9.73 a las 14:00 del 12-sep.",
    );
    expect(messages[1]!.content).toContain("- Inspeccionar el medidor y sus conexiones.");
    // El ejemplo few-shot cubre las 4 explicaciones (técnica + simple).
    expect(messages[1]!.content).toContain("El medidor M-109 está consumiendo casi el doble");
    expect(messages[1]!.content).toContain("- Llama a un electricista para revisar la instalación.");
    // El ejemplo muestra "\\n\\n" literal (representación JSON de los párrafos).
    expect(messages[1]!.content).toContain("\\n\\n");
    // El system prompt refuerza el contrato: nada de muros de texto ni numeración.
    expect(messages[0]!.content).toContain("muro de texto");
    expect(messages[0]!.content).toContain("NO numeres");
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
  test("parses the 4 fields (technical + simple) of a valid explanation", () => {
    const parsed = parseExplanation(
      JSON.stringify({
        reason: "Consumo muy por encima de la línea base durante un periodo sostenido.",
        recommended_action: "Revisar la instalación eléctrica del medidor.",
        reason_simple: "El medidor está consumiendo casi el doble de lo normal desde septiembre.",
        recommended_action_simple: "Llama a un electricista para revisar la instalación.",
      }),
    );
    expect(parsed.reason).toContain("línea base");
    expect(parsed.recommended_action).toContain("medidor");
    expect(parsed.reason_simple).toContain("doble de lo normal");
    expect(parsed.recommended_action_simple).toContain("electricista");
  });

  test("throws on malformed JSON", () => {
    expect(() => parseExplanation("not-json")).toThrow();
  });

  test("throws when required fields are missing", () => {
    expect(() => parseExplanation(JSON.stringify({ reason: "solo razón" }))).toThrow();
  });

  test("throws when the simple fields are missing", () => {
    expect(() =>
      parseExplanation(
        JSON.stringify({
          reason: "Razón técnica.",
          recommended_action: "Acción técnica.",
        }),
      ),
    ).toThrow();
  });

  test("throws when fields are empty strings", () => {
    expect(() =>
      parseExplanation(
        JSON.stringify({
          reason: "",
          recommended_action: "",
          reason_simple: "",
          recommended_action_simple: "",
        }),
      ),
    ).toThrow();
  });
});
describe("buildExplainPrompt — evento relacionado", () => {
  test("incluye el evento registrado y exige citarlo cuando existe", () => {
    const messages = buildExplainPrompt({
      ...anomaly,
      related_event: {
        event_type: "SCHEDULED_OUTAGE",
        event_timestamp: "2026-09-08T00:00:00.000Z",
        description: "Corte programado por mantenimiento durante 12 horas",
      },
    });
    const user = messages[1]!.content;
    expect(user).toContain("EVENTO RELACIONADO REGISTRADO EN EL SISTEMA");
    expect(user).toContain("Corte programado por mantenimiento durante 12 horas");
    expect(user).toContain("DEBE citarlo");
  });
});
