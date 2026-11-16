/**
 * "Copiar para tu asistente": a plain-text prompt the user pastes into whatever chat they use (ChatGPT, Gemini, Claude,
 * Le Chat…, free plans included), so their own assistant improves the draft or plays the jury and Mecena spends no AI.
 * The draft prompt asks for the sections back as "## Título" blocks, which the draft page can paste back in
 * (./reply.ts). Server-only: it reads the user's data; the route checks the application is theirs.
 */
import type { Application, Call, Profile, TranscriptSegment, Work } from "@/contracts";
import { getApplication, getCall, getProfile, getTranscript, listWorks } from "@/server/store";
import { WORDING_RULE } from "@/server/ai/wording";
import { judgeSystem } from "@/features/jury/ai";
import { criteriaFor, isVisualCriterion, judgesFor } from "@/features/jury/rules";

export type AssistantTask = "draft" | "jury";

const euros = (n: number) => `${n.toLocaleString("es-ES", { useGrouping: "always" })} €`;

const DRAFT_RULES = `Reglas (no te las saltes):
- Escribe en español de España y en primera persona, con mi voz: usa mis frases y mi vocabulario de «Mis palabras» (cítalas o parafraséalas de cerca), pero bien escritas.
${WORDING_RULE}
- NUNCA inventes datos (fechas, cifras, exposiciones, clientes, premios) que no estén en mis palabras, mi perfil, mis obras o el borrador. Si falta algo que las bases piden, escribe "[Completa: qué falta]".
- Haz que cada apartado responda a los criterios de valoración de la convocatoria, de forma concreta.
- Yo tengo la última palabra: escribe un borrador claro y honesto que pueda editar.`;

/** Profile facts worth passing on (no ids, owners or timestamps). */
function profileFacts(profile: Profile): Record<string, unknown> {
  const { id: _id, ownerId: _o, updatedAt: _u, ...rest } = profile as Profile & { ownerId?: string };
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));
}

function callBlock(call: Call, criteria = call.criteria): string {
  return [
    `Título: ${call.title}`,
    `Organiza: ${call.organizer}`,
    `Resumen: ${call.summary}`,
    `Cuantía: ${call.amountText}${call.amountEur.max ? ` (máximo ${euros(call.amountEur.max)})` : ""}`,
    `Plazo: ${call.deadlineText}`,
    criteria.length ? `Criterios de valoración:\n${criteria.map((c) => `- ${c.name} (hasta ${c.maxPoints} puntos): ${c.description}`).join("\n")}` : "",
    call.eligibility.other.length ? `Requisitos:\n${call.eligibility.other.map((r) => `- ${r}`).join("\n")}` : "",
    call.allowedExpenses.length ? `Gastos admitidos: ${call.allowedExpenses.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const wordsBlock = (t: readonly TranscriptSegment[]) => (t.length ? t.map((s) => `- ${s.text.trim()}`).join("\n") : "(todavía no hay entrevista)");

function worksBlock(works: readonly Work[]): string {
  if (!works.length) return "(sin obras)";
  return works
    .map(({ sheet: w }) => `- ${[w.title, w.year, w.technique, w.dimensions, w.duration, w.series && `serie ${w.series}`, w.venue].filter(Boolean).join(", ")}${w.concept ? `. ${w.concept}` : ""}`)
    .join("\n");
}

const draftBlock = (app: Application) => app.sections.map((s) => `## ${s.title}\n${s.body.trim()}`).join("\n\n");

function budgetBlock(app: Application): string {
  if (!app.budget.length) return "";
  const total = app.budget.reduce((a, l) => a + l.amountEur, 0);
  return `Presupuesto:\n${app.budget.map((l) => `- ${l.concept} (${l.expenseType}): ${euros(l.amountEur)}`).join("\n")}\nTotal: ${euros(total)}`;
}

export function draftPrompt(input: { profile: Profile; call: Call; application: Application; transcript: readonly TranscriptSegment[]; works: readonly Work[] }): string {
  const { profile, call, application, transcript, works } = input;
  const titles = application.sections.map((s) => `«${s.title}»`).join(", ");
  return `Estoy preparando con Mecena mi solicitud a una convocatoria y quiero que me ayudes a mejorar el borrador.

${DRAFT_RULES}

Qué te pido:
- Mejora la redacción de cada apartado del borrador con los datos de abajo. Si te falta un dato importante, pregúntamelo antes de inventar nada.
- Devuélveme SOLO los apartados, cada uno empezando por una línea "## " con su título exacto (${titles}) y el texto debajo. Así puedo pegar tu respuesta en Mecena tal cual.
- No toques el presupuesto ni la lista de documentos: los llevo en Mecena.

=== LA CONVOCATORIA ===
${callBlock(call)}

=== MI PERFIL (${profile.kind === "creator" ? "artista o creador/a" : "pyme o autónomo/a"}) ===
${JSON.stringify(profileFacts(profile), null, 1)}

=== MIS PALABRAS (de la entrevista) ===
${wordsBlock(transcript)}

=== MIS OBRAS ===
${worksBlock(works)}

=== EL BORRADOR ACTUAL ===
${draftBlock(application)}
`;
}

export function juryPrompt(input: { profile: Profile; call: Call; application: Application; works: readonly Work[] }): string {
  const { profile, call, application, works } = input;
  const { criteria, estimated } = criteriaFor(call, profile.kind);
  const judges = judgesFor(profile.kind);
  const visual = criteria.filter(isVisualCriterion).map((c) => `«${c.name}»`);
  return `Quiero que hagas de tribunal simulado para mi solicitud a una convocatoria (es orientativo: no predice la resolución real).

${judgeSystem(estimated)}

Sois ${judges.length} jueces; puntúa como cada uno por separado:
${judges.map((j) => `- ${j.name}: se fija sobre todo en ${j.focus}`).join("\n")}
${visual.length ? `\nLos criterios ${visual.join(", ")} se valoran solo por lo escrito: no ves las obras.\n` : ""}
Qué te pido:
- Para cada juez: los puntos de cada criterio (entre 0 y su máximo), un comentario de una línea y 1-2 mejoras concretas que yo pueda hacer con mis propios datos.
- Al final: la media de los tres jueces por criterio, la puntuación total sobre 100 y las 3 mejoras más importantes.

=== LA CONVOCATORIA ===
${callBlock(call, criteria)}

=== MIS OBRAS (fichas técnicas) ===
${worksBlock(works)}

=== MI SOLICITUD ===
${draftBlock(application)}
${budgetBlock(application) ? `\n${budgetBlock(application)}\n` : ""}`;
}

/** The prompt for one of the user's applications (the caller checked it is theirs). */
export function assistantPrompt(applicationId: string, task: AssistantTask): string {
  const application = getApplication(applicationId);
  const profile = getProfile(application.profileId);
  const call = getCall(application.callId);
  const works = listWorks(profile.id);
  return task === "jury" ? juryPrompt({ profile, call, application, works }) : draftPrompt({ profile, call, application, works, transcript: getTranscript(profile.id) });
}
