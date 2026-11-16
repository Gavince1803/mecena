// Owned by WP-08. "Prepárame la solicitud": one draft per profile × call. On the free plan it is the rule-based draft
// (no AI spent) for a call the free plan shows; with Pro, or a call unlocked with a Solicitud premium, Mecena's model
// writes it when the server has AI.
import { BadRequestError, PaymentRequiredError, type Application, type ApplicationSection, type BudgetLine, type ProfileKind, type ToolContext, type TranscriptSegment } from "@/contracts";
import { getAi } from "@/server/ai";
import { findApplication, getCall, getDossier, getProfile, getTranscript, listWorks, newId, nowIso, saveApplication } from "@/server/store";
import { CALL_LOCKED_MESSAGE, canUseCall } from "@/features/purchases/server";
import { canSeeCall } from "@/features/matching/usage";
import { DRAFT_SYSTEM, mockDraft } from "./ai";
import { enforce, needsBudget, validateBudget } from "./rules";

/** The free plan drafts only the calls it shows (its monthly matches, or a recurring call already closed). */
export const DRAFT_LOCKED_MESSAGE = `${CALL_LOCKED_MESSAGE}: con el plan gratuito preparas la solicitud de tus convocatorias del mes`;

/**
 * How this user may draft for this call: "paid" (Pro, or the call unlocked with a Solicitud premium: Mecena's model
 * writes it when the server has AI) or "free" (the rule-based draft, for a call the free plan shows; seeing it may use
 * one of the month's free matches, as opening it does). Otherwise PaymentRequiredError. Never spends a credit.
 */
export async function draftAccess(input: { callId: string; profileId: string }, ctx: Pick<ToolContext, "appUserId">): Promise<"paid" | "free"> {
  if (await canUseCall(ctx.appUserId, input.callId)) return "paid";
  if (getCall(input.callId).status === "recurring") return "free";
  if (await canSeeCall({ appUserId: ctx.appUserId, profileId: input.profileId, callId: input.callId, pro: false })) return "free";
  throw new PaymentRequiredError(DRAFT_LOCKED_MESSAGE);
}

/** Drafts in progress per `${profileId}|${callId}`: a double tap waits for the same draft instead of drafting twice. */
const inflight = new Map<string, Promise<Application>>();

/**
 * Returns the existing draft for this call if there is one (nothing is re-drafted); otherwise checks the access
 * BEFORE any AI (402 when the call needs Pro or a Solicitud premium), drafts and saves. A free draft is always the
 * rule-based one and is marked `plan: "free"`.
 */
export async function draftApplication(input: { callId: string; profileId: string }, ctx: Pick<ToolContext, "appUserId"> & Partial<Pick<ToolContext, "caller">>): Promise<Application> {
  const profile = getProfile(input.profileId);
  const call = getCall(input.callId);
  const existing = findApplication(profile.id, call.id);
  if (existing) return existing;
  const key = `${profile.id}|${call.id}`;
  const running = inflight.get(key);
  if (running) return running;

  const job = (async (): Promise<Application> => {
    const access = await draftAccess({ callId: call.id, profileId: profile.id }, ctx);
    const args = { profile, call, transcript: getTranscript(profile.id), dossier: getDossier(profile.id), works: listWorks(profile.id) };
    const content = access === "free" ? mockDraft(args) : await getAi().draftApplication(args);
    const now = nowIso();
    const app: Application = {
      id: newId("app"),
      profileId: profile.id,
      callId: call.id,
      version: 1,
      status: "draft",
      ...content,
      ...(access === "free" ? { plan: "free" as const } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await saveApplication(app);
    return app;
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/** The draft for a call, if any (page load: show it instead of offering to draft again). */
export function findDraft(input: { callId: string; profileId: string }): Application | null {
  const profile = getProfile(input.profileId);
  return findApplication(profile.id, input.callId) ?? null;
}

/** Transcript segments a draft quotes, so the UI can show "Escrito con tus palabras". */
export function draftSources(app: Application): Record<string, TranscriptSegment> {
  const used = new Set(app.sections.flatMap((s) => s.sourceSegmentIds));
  return Object.fromEntries(getTranscript(app.profileId).filter((s) => used.has(s.id)).map((s) => [s.id, s]));
}

// ---- Client-side drafting (MCP): the user's own Claude writes the draft, Mecena hands it the context and checks it ----

/** Section keys a draft uses, per kind (the same ones the server model is asked for). */
export const SECTION_KEYS: Record<ProfileKind, string[]> = { creator: ["memoria", "statement", "cv"], business: ["company", "memoria", "objetivos"] };

const CLIENT_DRAFT_FORMAT = `Formato: "sections" es una lista de {key, title, body, sourceSegmentIds}; usa las claves de "sectionKeys" (la de trayectoria, "cv", solo si hay datos). Separa los párrafos de "body" con una línea en blanco. "sourceSegmentIds" son ids de "transcript".
"budget" es una lista de {concept, amountEur, expenseType, note?}: solo si "needsBudget" es true, con "expenseType" copiado tal cual de call.allowedExpenses y un total que no pase de call.amountEur.max. Si la persona no ha dado importes, propón importes orientativos y dilo en "note".
La checklist de documentos la monta Mecena con las bases: no la envíes.
Antes de guardar, enseña el borrador a la persona si te lo pide; después guárdalo con save_application_draft.`;

/**
 * What a client model needs to write the draft itself (get_application_context). A first draft needs access to the call
 * (draftAccess): checked here so the model does not write for nothing. Nothing is spent: the client model does the work.
 */
export async function clientDraftContext(input: { callId: string; profileId: string }, ctx: Pick<ToolContext, "appUserId">) {
  const profile = getProfile(input.profileId);
  const call = getCall(input.callId);
  const existing = findApplication(profile.id, call.id);
  if (!existing) await draftAccess({ callId: call.id, profileId: profile.id }, ctx);
  return {
    instructions: `${DRAFT_SYSTEM}\n${CLIENT_DRAFT_FORMAT}`,
    sectionKeys: SECTION_KEYS[profile.kind],
    needsBudget: needsBudget(call),
    profile,
    transcript: getTranscript(profile.id).map((s) => ({ id: s.id, text: s.text })),
    works: listWorks(profile.id).map((w) => w.sheet),
    call,
    ...(existing ? { existing } : {}),
  };
}

/** Saves per `${profileId}|${callId}`, one at a time: two concurrent first saves never create two drafts. */
const saving = new Map<string, Promise<unknown>>();

/**
 * Save a draft written by a client model (save_application_draft). The budget is checked, never rewritten: a line the
 * bases do not allow or a total above the maximum is a BadRequestError with the reason, so the model can fix it. Then
 * the same rules as a server draft (./rules.enforce): source ids that are not the user's words are dropped and the
 * checklist is rebuilt from the call (keeping what the user already ticked). Over an existing draft it is a new
 * version (like an edit in the app); a first draft needs access to the call (draftAccess) and spends nothing.
 */
export async function saveClientDraft(
  input: { callId: string; profileId: string; sections: ApplicationSection[]; budget: BudgetLine[] },
  ctx: Pick<ToolContext, "appUserId">,
): Promise<{ application: Application; created: boolean }> {
  const profile = getProfile(input.profileId);
  const call = getCall(input.callId);
  let budget: BudgetLine[] = [];
  if (needsBudget(call)) {
    const checked = validateBudget(input.budget, call);
    if ("error" in checked) throw new BadRequestError(checked.error);
    budget = checked.budget;
  }
  const key = `${profile.id}|${call.id}`;
  const prev = saving.get(key) ?? Promise.resolve();
  const job = prev
    .catch(() => undefined)
    .then(async () => {
      const existing = findApplication(profile.id, call.id);
      const content = enforce({ sections: input.sections, budget, checklist: existing?.checklist ?? [] }, call, getTranscript(profile.id));
      const now = nowIso();
      if (existing) return { application: await saveApplication({ ...existing, ...content, version: existing.version + 1, updatedAt: now }), created: false };
      const access = await draftAccess({ callId: call.id, profileId: profile.id }, ctx);
      const app: Application = {
        id: newId("app"),
        profileId: profile.id,
        callId: call.id,
        version: 1,
        status: "draft",
        ...content,
        ...(access === "free" ? { plan: "free" as const } : {}),
        createdAt: now,
        updatedAt: now,
      };
      return { application: await saveApplication(app), created: true };
    });
  saving.set(key, job);
  try {
    return await job;
  } finally {
    if (saving.get(key) === job) saving.delete(key);
  }
}
