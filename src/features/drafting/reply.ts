/**
 * Client-safe helpers of the draft page that need no AI:
 * - parseAssistantReply: the answer the user pastes back from their own assistant ("## Título" blocks, as the prompt in
 *   ./assistant.ts asks) → the draft's sections, matched by title (or key), never inventing new sections;
 * - listGaps / fillGap: the "[Completa: …]" gaps of a draft, filled one by one with the user's own answer, word for word.
 */
import type { ApplicationSection } from "@/contracts";

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "## **Memoria del proyecto**", "### 1. Memoria del proyecto:", "**Memoria del proyecto**" → "memoria del proyecto". */
function headingTitle(line: string): string | null {
  const m = /^\s*(?:#{1,4}\s+(.+?)|\*\*(.+?)\*\*\s*:?)\s*$/.exec(line);
  const raw = m?.[1] ?? m?.[2];
  if (!raw) return null;
  return fold(raw.replace(/\*\*/g, "").replace(/^\d+[.)]\s*/, "").replace(/:$/, ""));
}

/** Markdown leftovers a chat adds to a paragraph (bold, italics), stripped so the draft reads as plain text. */
const plain = (s: string) =>
  s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export type ParsedReply = { sections: ApplicationSection[]; matched: string[]; unmatched: string[] } | { error: string };

/**
 * The sections of `current` with the bodies from the pasted reply. A block whose heading matches no section is reported
 * in `unmatched` (and left out); sections the reply does not mention keep their text. When no heading matches but the
 * reply has exactly as many blocks as the draft has sections, they are taken in order.
 */
export function parseAssistantReply(text: string, current: readonly ApplicationSection[]): ParsedReply {
  const blocks: { title: string; heading: string; body: string[] }[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const title = headingTitle(line);
    if (title !== null) blocks.push({ title, heading: line.replace(/[#*]/g, "").trim(), body: [] });
    else blocks.at(-1)?.body.push(line);
  }
  const found = blocks.map((b) => ({ ...b, text: plain(b.body.join("\n")) })).filter((b) => b.text);
  if (!found.length) return { error: "No encuentro los apartados en la respuesta. Pide a tu asistente que empiece cada apartado con una línea «## Título»." };

  const byTitle = (b: (typeof found)[number]) => current.findIndex((s) => fold(s.title) === b.title || fold(s.key) === b.title);
  let pairs = found.map((b) => ({ b, i: byTitle(b) }));
  if (pairs.every((p) => p.i < 0) && found.length === current.length) pairs = found.map((b, i) => ({ b, i }));

  const sections = current.map((s) => ({ ...s, sourceSegmentIds: [...s.sourceSegmentIds] }));
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const { b, i } of pairs) {
    if (i < 0 || matched.includes(sections[i].title)) {
      unmatched.push(b.heading);
      continue;
    }
    sections[i] = { ...sections[i], body: b.text };
    matched.push(sections[i].title);
  }
  if (!matched.length) return { error: `Los títulos de la respuesta no coinciden con los de tu solicitud (${current.map((s) => `«${s.title}»`).join(", ")}).` };
  return { sections, matched, unmatched };
}

export interface Gap {
  /** Index of the section in the draft. */
  section: number;
  /** The gap as written, "[Completa: fechas de inicio y fin]". */
  text: string;
  /** What it asks for, "fechas de inicio y fin". */
  label: string;
}

const GAP = /\[Completa:\s*([^\]]*)\]/g;

/** Every "[Completa: …]" gap of the draft, in reading order. */
export function listGaps(sections: readonly ApplicationSection[]): Gap[] {
  return sections.flatMap((s, section) => [...s.body.matchAll(GAP)].map((m) => ({ section, text: m[0], label: m[1].trim() })));
}

/** The draft with that gap (its first occurrence in its section) replaced by the user's answer, as they wrote it. */
export function fillGap(sections: readonly ApplicationSection[], gap: Gap, answer: string): ApplicationSection[] {
  const value = answer.trim();
  if (!value) return [...sections];
  return sections.map((s, i) => (i === gap.section ? { ...s, body: s.body.replace(gap.text, value) } : s));
}
