import { describe, expect, test } from "bun:test";
import {
  normalizeAction,
  normalizeActionSimple,
  normalizeReason,
  normalizeReasonSimple,
} from "../domain/llm-format";

describe("normalizeReason", () => {
  test("turns a wall of text into 2-3 paragraphs separated by a blank line", () => {
    const wall =
      "El consumo pasó de 43.7 a 92.8 kWh/h (+112.3%), con un pico de |z| 9.73 a las 14:00 del 12-sep. No hay evento que explique la señal: el medidor no registró mantenimiento ni cambios operativos. El impacto es alto: el consumo se duplicó y se mantiene elevado. Se recomienda inspeccionar el medidor y verificar la carga conectada.";
    const normalized = normalizeReason(wall);
    const paragraphs = normalized.split("\n\n");
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(paragraphs.length).toBeLessThanOrEqual(3);
    expect(normalized).toContain("\n\n");
    for (const paragraph of paragraphs) {
      expect(paragraph.trim()).toBe(paragraph);
      expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  test("does not split inside decimals, units or abbreviations", () => {
    const normalized = normalizeReason(
      "El consumo pasó de 43.7 a 92.8 kWh/h (+112.3%), con un pico de |z| 9.73 a las 14:00 del 12-sep. La señal es clara.",
    );
    const paragraphs = normalized.split("\n\n");
    // La primera frase se conserva íntegra: decimales, porcentajes y unidades
    // con punto no cuentan como fin de frase.
    expect(paragraphs[0]).toBe(
      "El consumo pasó de 43.7 a 92.8 kWh/h (+112.3%), con un pico de |z| 9.73 a las 14:00 del 12-sep. La señal es clara.",
    );
  });

  test("caps at 3 paragraphs when the text already has paragraph breaks", () => {
    const five = Array.from(
      { length: 5 },
      (_, i) => `Párrafo ${i + 1}: una frase con números 43.7 y 9.73.`,
    ).join("\n\n");
    expect(normalizeReason(five).split("\n\n")).toHaveLength(3);
  });

  test("groups a long wall of text into paragraphs of at most 3 sentences", () => {
    const wall = Array.from(
      { length: 10 },
      (_, i) => `Frase número ${i + 1} de la evidencia.`,
    ).join(" ");
    const normalized = normalizeReason(wall);
    const paragraphs = normalized.split("\n\n");
    expect(paragraphs).toHaveLength(3);
    for (const paragraph of paragraphs) {
      const sentenceCount = paragraph
        .split(".")
        .filter((part) => part.trim().length > 0).length;
      expect(sentenceCount).toBeLessThanOrEqual(3);
    }
  });

  test("collapses 3+ newlines to a blank line separator", () => {
    expect(normalizeReason("Primer párrafo.\n\n\n\nSegundo párrafo.")).toBe(
      "Primer párrafo.\n\nSegundo párrafo.",
    );
  });

  test("keeps already-formatted text stable (idempotent)", () => {
    const formatted =
      "Párrafo uno: primera frase. Segunda frase con 43.7 y 92.8 kWh/h.\n\nPárrafo dos: una sola frase.";
    expect(normalizeReason(formatted)).toBe(formatted);
    expect(normalizeReason(normalizeReason(formatted))).toBe(normalizeReason(formatted));
  });

  test("fallback string (por reglas) is stable through the normalizer", () => {
    const fallback =
      "Anomalía REAL_ANOMALY (SPIKE, max |z| 9.73, variación 112.3%).\n\nEl proveedor de IA no estuvo disponible; explicación generada por reglas.";
    expect(normalizeReason(fallback)).toBe(fallback);
    expect(normalizeReason(normalizeReason(fallback))).toBe(normalizeReason(fallback));
  });

  test("returns an empty string for empty input", () => {
    expect(normalizeReason("")).toBe("");
    expect(normalizeReason("   \n  ")).toBe("");
  });
});

describe("normalizeAction", () => {
  test("converts numbered items to '- ' bullets", () => {
    const numbered =
      "1) Inspeccionar el medidor y sus conexiones.\n2. Verificar la carga conectada al circuito.\n3) Revisar el historial de las últimas 48 horas.";
    expect(normalizeAction(numbered)).toBe(
      "- Inspeccionar el medidor y sus conexiones.\n- Verificar la carga conectada al circuito.\n- Revisar el historial de las últimas 48 horas.",
    );
  });

  test("splits a single blob into '- ' bullets (first 4 sentences)", () => {
    const blob =
      "Inspeccionar el medidor y sus conexiones. Verificar la carga conectada al circuito. Revisar el historial de las últimas 48 horas. Monitorear el consumo durante una semana. Escalar a mantenimiento si persiste.";
    expect(normalizeAction(blob)).toBe(
      "- Inspeccionar el medidor y sus conexiones.\n- Verificar la carga conectada al circuito.\n- Revisar el historial de las últimas 48 horas.\n- Monitorear el consumo durante una semana.",
    );
  });

  test("caps at 4 items", () => {
    const six = Array.from({ length: 6 }, (_, i) => `${i + 1}) Acción número ${i + 1}.`).join(
      "\n",
    );
    expect(normalizeAction(six).split("\n")).toHaveLength(4);
  });

  test("drops empty lines and guarantees every line starts with '- '", () => {
    const messy =
      "\n1) Primera acción.\n\n2) Segunda acción.\n\n\n3) Tercera acción.\n";
    expect(normalizeAction(messy)).toBe(
      "- Primera acción.\n- Segunda acción.\n- Tercera acción.",
    );
  });

  test("keeps already-formatted bullets stable (idempotent)", () => {
    const formatted =
      "- Inspeccionar el medidor y sus conexiones.\n- Verificar la carga conectada al circuito.";
    expect(normalizeAction(formatted)).toBe(formatted);
    expect(normalizeAction(normalizeAction(formatted))).toBe(normalizeAction(formatted));
  });

  test("fallback action (por reglas) is stable through the normalizer", () => {
    const fallback = "- Inspeccionar el medidor y sus conexiones.\n- Verificar la carga conectada al circuito.";
    expect(normalizeAction(fallback)).toBe(fallback);
    expect(normalizeAction(normalizeAction(fallback))).toBe(normalizeAction(fallback));
  });

  test("returns an empty string for empty input", () => {
    expect(normalizeAction("")).toBe("");
    expect(normalizeAction("   ")).toBe("");
  });
});

describe("normalizeReasonSimple", () => {
  test("groups a wall of text into 1-2 paragraphs of at most 2 sentences", () => {
    const wall =
      "El medidor M-109 está consumiendo casi el doble de lo normal desde el 12 de septiembre. La caída en la eficiencia eléctrica sugiere que algo se conectó o se dañó en la instalación. Se recomienda llamar a un electricista para revisar.";
    const normalized = normalizeReasonSimple(wall);
    const paragraphs = normalized.split("\n\n");
    expect(paragraphs.length).toBeGreaterThanOrEqual(1);
    expect(paragraphs.length).toBeLessThanOrEqual(2);
    for (const paragraph of paragraphs) {
      const sentenceCount = paragraph
        .split(".")
        .filter((part) => part.trim().length > 0).length;
      expect(sentenceCount).toBeLessThanOrEqual(2);
    }
  });

  test("caps at 2 paragraphs when the text already has paragraph breaks", () => {
    const three = Array.from(
      { length: 3 },
      (_, i) => `Párrafo ${i + 1}: una frase cotidiana.`,
    ).join("\n\n");
    expect(normalizeReasonSimple(three).split("\n\n")).toHaveLength(2);
  });

  test("keeps already-formatted text stable (idempotent)", () => {
    const formatted =
      "El consumo subió de forma notoria desde hace unos días.\n\nAlgo se conectó o se dañó en la instalación.";
    expect(normalizeReasonSimple(formatted)).toBe(formatted);
    expect(normalizeReasonSimple(normalizeReasonSimple(formatted))).toBe(
      normalizeReasonSimple(formatted),
    );
  });

  test("keeps the fallback simple string stable through the normalizer", () => {
    const fallback =
      "El consumo cambió un 112.3% respecto a lo normal.\n\nEl sistema no pudo consultar al asistente automático, así que esta explicación se generó automáticamente.";
    expect(normalizeReasonSimple(fallback)).toBe(fallback);
    expect(normalizeReasonSimple(normalizeReasonSimple(fallback))).toBe(
      normalizeReasonSimple(fallback),
    );
  });

  test("returns an empty string for empty input", () => {
    expect(normalizeReasonSimple("")).toBe("");
    expect(normalizeReasonSimple("   \n  ")).toBe("");
  });
});

describe("normalizeActionSimple", () => {
  test("converts numbered items to '- ' bullets, capping at 3", () => {
    const numbered =
      "1) Llama a un electricista para revisar la instalación.\n2. Verifica si se conectó un equipo nuevo.\n3) Pide revisar el medidor si el problema persiste.\n4) Escala a mantenimiento si nada cambia.";
    expect(normalizeActionSimple(numbered)).toBe(
      "- Llama a un electricista para revisar la instalación.\n- Verifica si se conectó un equipo nuevo.\n- Pide revisar el medidor si el problema persiste.",
    );
  });

  test("splits a single blob into at most 3 '- ' bullets", () => {
    const blob =
      "Llama a un electricista. Verifica si se conectó un equipo nuevo. Pide revisar el medidor. Escala a mantenimiento si persiste.";
    expect(normalizeActionSimple(blob).split("\n")).toHaveLength(3);
    for (const line of normalizeActionSimple(blob).split("\n")) {
      expect(line.startsWith("- ")).toBe(true);
    }
  });

  test("keeps already-formatted bullets stable (idempotent)", () => {
    const formatted =
      "- Llama a un electricista para revisar la instalación.\n- Verifica si se conectó un equipo nuevo en esos días.";
    expect(normalizeActionSimple(formatted)).toBe(formatted);
    expect(normalizeActionSimple(normalizeActionSimple(formatted))).toBe(
      normalizeActionSimple(formatted),
    );
  });

  test("returns an empty string for empty input", () => {
    expect(normalizeActionSimple("")).toBe("");
    expect(normalizeActionSimple("   ")).toBe("");
  });
});