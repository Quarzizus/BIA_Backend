/**
 * Normalización del contrato de formato LLM (reason / recommended_action y sus
 * versiones "simples" para público general).
 *
 * Módulo puro y defensivo: garantiza el formato canónico SIN importar qué
 * devuelva el modelo, para que lo persistido siempre cumpla el contrato:
 *  - reason: 2-3 párrafos cortos separados por línea en blanco ("\n\n"),
 *    cada párrafo de 1-3 frases.
 *  - recommended_action: 2-4 items, cada uno en su línea con prefijo "- ",
 *    una frase imperativa en español por item.
 *  - reason_simple: 1-2 párrafos de 1-2 frases, separados por "\n\n".
 *  - recommended_action_simple: 2-3 items con prefijo "- ".
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
/** Máximo de párrafos de reason_simple. */
const MAX_REASON_SIMPLE_PARAGRAPHS = 2;
/** Máximo de frases por párrafo de reason_simple. */
const MAX_SENTENCES_PER_SIMPLE_PARAGRAPH = 2;
/** Máximo de items de recommended_action_simple. */
const MAX_ACTION_SIMPLE_ITEMS = 3;

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
 * Helper compartido: separa un texto que ya contiene párrafos ("\n\n") en
 * párrafos limpios, colapsa 3+ saltos a 2, descarta vacíos y limita el total.
 */
function splitIntoParagraphs(text: string, maxParagraphs: number): string {
  return text
    .replace(COLLAPSE_BREAKS, "\n\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .slice(0, maxParagraphs)
    .join("\n\n");
}

/**
 * Helper compartido: agrupa un muro de texto en párrafos de a lo sumo
 * `sentencesPerParagraph` frases, con un máximo de `maxParagraphs` párrafos
 * (el excedente se descarta).
 */
function groupSentencesIntoParagraphs(
  text: string,
  maxParagraphs: number,
  sentencesPerParagraph: number,
): string {
  const sentences = splitSentences(text);
  const paragraphs: string[] = [];
  for (
    let index = 0;
    index < sentences.length && paragraphs.length < maxParagraphs;
    index += sentencesPerParagraph
  ) {
    paragraphs.push(sentences.slice(index, index + sentencesPerParagraph).join(" "));
  }
  return paragraphs.join("\n\n");
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
    return splitIntoParagraphs(text, MAX_REASON_PARAGRAPHS);
  }
  return groupSentencesIntoParagraphs(text, MAX_REASON_PARAGRAPHS, MAX_SENTENCES_PER_PARAGRAPH);
}

/**
 * Normaliza `reason_simple` al contrato canónico: SIEMPRE empieza con
 * "Idea principal: <frase corta, máx 2 líneas>" seguida de una línea en blanco
 * y el resto de la explicación en lenguaje cotidiano (1 párrafo de 1-2 frases).
 *
 * - Si el texto ya trae el prefijo "Idea principal:" (case-insensitive), la
 *   idea es la 1ª-2ª frase tras el prefijo y el resto es el cuerpo.
 * - Si no lo trae, la PRIMERA frase se convierte en la idea principal y las
 *   siguientes en el cuerpo — la garantía no depende del humor del modelo.
 */
export function normalizeReasonSimple(raw: string): string {
  const text = raw.trim();
  if (text === "") return "";

  const hasPrefix = /^idea principal\s*:/i.test(text);
  const content = hasPrefix ? text.replace(/^idea principal\s*:/i, "").trim() : text;
  const sentences = splitSentences(content);

  if (sentences.length === 0) return "Idea principal: ";
  // La idea principal es UNA frase corta (máx 2 líneas en pantalla); el resto
  // del texto es el cuerpo. Cortar en 2 frases rompería la idempotencia cuando
  // el cuerpo ya está separado por "\n\n".
  const mainIdea = sentences[0]!;
  const body = groupSentencesIntoParagraphs(
    sentences.slice(1).join(" "),
    1,
    MAX_SENTENCES_PER_SIMPLE_PARAGRAPH,
  );

  return body ? `Idea principal: ${mainIdea}\n\n${body}` : `Idea principal: ${mainIdea}`;
}

/**
 * Helper compartido de actions: convierte líneas o frases a items con prefijo
 * "- ", descartando líneas vacías y limitando la lista a `maxItems`.
 */
function buildActionItems(raw: string, maxItems: number): string {
  const text = raw.trim();
  if (text === "") return "";

  const items: string[] = [];
  const pushItem = (line: string): void => {
    const content = line
      .trim()
      .replace(/^\d+[).]\s*/, "") // "1)", "2.", "1." → sin número
      .replace(/^[-*•]\s*/, ""); // bullets existentes ("- ", "*", "•") → sin prefijo
    if (content.length > 0 && items.length < maxItems) {
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
  return buildActionItems(raw, MAX_ACTION_ITEMS);
}

/**
 * Normaliza `recommended_action_simple` al contrato canónico: 2-3 items con
 * prefijo "- ", pasos cotidianos. Misma lógica que `normalizeAction` pero con
 * un tope de 3 items.
 */
export function normalizeActionSimple(raw: string): string {
  return buildActionItems(raw, MAX_ACTION_SIMPLE_ITEMS);
}

/**
 * Conteo de "grupos de contenido" del texto crudo, según el contrato:
 *  - párrafos si ya hay separación "\n\n" (el colapso de 3+ saltos no altera
 *    el conteo), o frases si es un bloque único;
 *  - items (líneas) si hay saltos de línea, o frases si es un bloque único.
 * Se usa para detectar cuándo el normalizador descartó contenido (F9).
 */
function countRawGroups(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const collapsed = trimmed.replace(COLLAPSE_BREAKS, "\n\n");
  if (collapsed.includes("\n\n")) {
    return collapsed
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0).length;
  }
  if (collapsed.includes("\n")) {
    return collapsed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  }
  return splitSentences(collapsed).length;
}

function countNormalizedGroups(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  if (trimmed.includes("\n")) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0).length;
  }
  return trimmed.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0).length;
}

/**
 * ¿El normalizador descartó contenido de `raw` al producir `normalized`?
 * true si el texto crudo excede el tope de párrafos del contrato de reason
 * (3) y la normalización quedó más corta que el crudo.
 */
export function reasonWasTruncated(raw: string, normalized: string): boolean {
  return (
    countRawGroups(raw) > MAX_REASON_PARAGRAPHS &&
    countNormalizedGroups(normalized) < countRawGroups(raw)
  );
}

/** Igual que `reasonWasTruncated` pero con el tope simple (2 párrafos). */
export function reasonSimpleWasTruncated(raw: string, normalized: string): boolean {
  return (
    countRawGroups(raw) > MAX_REASON_SIMPLE_PARAGRAPHS &&
    countNormalizedGroups(normalized) < countRawGroups(raw)
  );
}

/** ¿El normalizador descartó items de `raw`? Tope del contrato de action: 4. */
export function actionWasTruncated(raw: string, normalized: string): boolean {
  return (
    countRawGroups(raw) > MAX_ACTION_ITEMS &&
    countNormalizedGroups(normalized) < countRawGroups(raw)
  );
}

/** Igual que `actionWasTruncated` pero con el tope simple (3 items). */
export function actionSimpleWasTruncated(raw: string, normalized: string): boolean {
  return (
    countRawGroups(raw) > MAX_ACTION_SIMPLE_ITEMS &&
    countNormalizedGroups(normalized) < countRawGroups(raw)
  );
}