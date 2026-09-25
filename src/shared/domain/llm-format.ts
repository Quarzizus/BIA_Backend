/**
 * Normalización del contrato de formato LLM (reason / recommended_action).
 *
 * Módulo puro y defensivo: garantiza el formato canónico SIN importar qué
 * devuelva el modelo, para que lo persistido siempre cumpla el contrato:
 *  - reason: 2-3 párrafos cortos separados por línea en blanco ("\n\n"),
 *    cada párrafo de 1-3 frases.
 *  - recommended_action: 2-4 items, cada uno en su línea con prefijo "- ",
 *    una frase imperativa en español por item.
 *
 * Sin zod, sin Prisma, sin Express: solo strings. Si el texto ya cumple el
 * contrato, la normalización es idempotente (no lo altera).
 */

/** Máximo de párrafos de reason. */
const MAX_REASON_PARAGRAPHS = 3;
/** Máximo de frases por párrafo de reason. */
const MAX_SENTENCES_PER_PARAGRAPH = 3;
/** Máximo de items de recommended_action. */
const MAX_ACTION_ITEMS = 4;

/**
 * Límite de frase: fin de frase (`.`, `!`, `?`) seguido de espacios y de un
 * carácter que inicia frase (mayúscula o apertura de cita/interrogación).
 * NO rompe dentro de decimales ("43.7", "z=9.7") ni unidades ("kWh/h"): el
 * lookahead exige una mayúscula/«/¿/¡ tras el espacio, nunca un dígito.
 */
const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡«])/;

/** Colapsa 3+ saltos de línea a 2 (separador canónico de párrafo). */
const COLLAPSE_BREAKS = /\n{3,}/g;

function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, " ")
    .split(SENTENCE_BOUNDARY)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Normaliza `reason` al contrato canónico: 2-3 párrafos de 1-3 frases
 * separados por línea en blanco ("\n\n").
 *
 * - Si el texto ya tiene párrafos ("\n\n"): se tratan, se colapsan 3+ saltos
 *   de línea a 2, se descartan párrafos vacíos y se limita a 3.
 * - Si es un muro de texto: se parte en frases (sin romper decimales,
 *   unidades ni abreviaturas) y se agrupan en párrafos de hasta 3 frases,
 *   con un máximo de 3 párrafos (el excedente se descarta).
 */
export function normalizeReason(raw: string): string {
  const text = raw.trim();
  if (text === "") return "";

  if (text.includes("\n\n")) {
    const paragraphs = text
      .replace(COLLAPSE_BREAKS, "\n\n")
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0);
    return paragraphs.slice(0, MAX_REASON_PARAGRAPHS).join("\n\n");
  }

  const sentences = splitSentences(text);
  const paragraphs: string[] = [];
  for (
    let index = 0;
    index < sentences.length && paragraphs.length < MAX_REASON_PARAGRAPHS;
    index += MAX_SENTENCES_PER_PARAGRAPH
  ) {
    paragraphs.push(sentences.slice(index, index + MAX_SENTENCES_PER_PARAGRAPH).join(" "));
  }
  return paragraphs.join("\n\n");
}

/**
 * Normaliza `recommended_action` al contrato canónico: 2-4 items, cada uno en
 * su línea con prefijo "- ".
 *
 * - Con saltos de línea: cada línea se convierte en un item; el prefijo
 *   numérico ("1)", "2.", "1.") se reemplaza por "- ".
 * - Sin saltos de línea (bloque único): se parte en frases y se toman las
 *   primeras 4, cada una como item.
 * - Las líneas vacías se descartan y la lista se limita a 4 items.
 */
export function normalizeAction(raw: string): string {
  const text = raw.trim();
  if (text === "") return "";

  const items: string[] = [];
  const pushItem = (line: string): void => {
    const content = line
      .trim()
      .replace(/^\d+[).]\s*/, "") // "1)", "2.", "1." → sin número
      .replace(/^[-*•]\s*/, ""); // bullets existentes ("- ", "*", "•") → sin prefijo
    if (content.length > 0 && items.length < MAX_ACTION_ITEMS) {
      items.push(`- ${content}`);
    }
  };

  if (text.includes("\n")) {
    for (const line of text.split(/\r?\n/)) pushItem(line);
  } else {
    for (const sentence of splitSentences(text)) pushItem(sentence);
  }

  return items.join("\n");
}