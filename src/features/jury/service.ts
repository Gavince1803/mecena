// Owned by WP-08. Simulated jury: 3 judges in parallel on the call's criteria (official or estimated), scores clamped
// and averaged, normalised to 100. "Aplicar mejoras" revises from the user's facts (idempotent, undoable) and re-scores.
import { BadRequestError, ConflictError, PaymentRequiredError, type Application, type ApplicationSnapshot, type CallCriterion, type JudgePersona, type JudgeVerdict, type JuryScore, type ToolContext, type UserFact } from "@/contracts";
import { getAi } from "@/server/ai";
import { getApplication, getCall, getProfile, getTranscript, latestJuryScore, listJuryScores, listWorks, newId, nowIso, saveApplication, saveJuryScore } from "@/server/store";
import { juryRunLimit, juryRunsLeft, juryRunsMessage, resolveEntitlement, withJuryRun } from "@/features/purchases/server";
import { CREATOR_JUDGES, criteriaFor, isVisualCriterion, judgesFor } from "./rules";
import { judgeSystem } from "./ai";

/** Default personas (creator calls); business applications use BUSINESS_JUDGES (see ./rules). */
export const JUDGES: JudgePersona[] = CREATOR_JUDGES;
export { BUSINESS_JUDGES, CREATOR_JUDGES, judgesFor } from "./rules";

export const DISCLAIMER = "Simulación orientativa con los criterios de valoración publicados en las bases. No predice la resolución real.";
export const DISCLAIMER_ESTIMATED = "Simulación orientativa con criterios estimados: las bases no publican puntuaciones. No predice la resolución real.";

/** One judge finished: their total out of 100 (the UI shows it while the others are still reading). */
export interface JudgeEvent {
  judgeId: string;
  name: string;
  total: number;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

const ms = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(1)} s`;

/** A judge's score for a criterion: by id, then by name, then by position (a real model may reword the id). */
function scoreFor(v: JudgeVerdict, c: { id: string; name: string }, index: number, count: number) {
  return (
    v.scores.find((x) => x.criterionId === c.id) ??
    v.scores.find((x) => fold(x.criterionId) === fold(c.name) || fold(x.criterionId).startsWith(fold(c.id)) || fold(c.id).startsWith(fold(x.criterionId))) ??
    (v.scores.length === count ? v.scores[index] : undefined)
  );
}

interface Inflight {
  promise: Promise<JuryScore>;
  events: JudgeEvent[];
  listeners: Set<(e: JudgeEvent) => void>;
}
/** Scorings in progress per application version: a second request (prewarm + page, double tap) joins the first. */
const inflight = new Map<string, Inflight>();

async function runScoring(application: Application, emit: (e: JudgeEvent) => void): Promise<JuryScore> {
  const rawCall = getCall(application.callId);
  const kind = getProfile(application.profileId).kind;
  const { criteria: callCriteria, estimated } = criteriaFor(rawCall, kind);
  const call = { ...rawCall, criteria: callCriteria };
  const judges = judgesFor(kind);
  const works = listWorks(application.profileId);
  const max = call.criteria.reduce((a, c) => a + c.maxPoints, 0) || 100;
  const ai = getAi();
  const t0 = performance.now();

  const verdicts = await Promise.all(
    judges.map(async (judge) => {
      const v = await ai.judgeApplication({ call, application, judge, works });
      const sum = call.criteria.reduce((a, c, i) => a + Math.max(0, Math.min(c.maxPoints, scoreFor(v, c, i, call.criteria.length)?.points ?? 0)), 0);
      console.info(`[jury] ${application.id} v${application.version} judge ${judge.id} (${ai.mode}) in ${ms(t0)}`);
      emit({ judgeId: judge.id, name: judge.name, total: Math.round((sum / max) * 100) });
      return v;
    }),
  );
  const score = await saveJuryScore(aggregateVerdicts({ application, criteria: call.criteria, judges, verdicts, estimated }));
  console.info(`[jury] ${application.id} v${application.version} scored ${score.total} in ${ms(t0)}`);
  return score;
}

/**
 * The panel's score from one verdict per judge (verdicts[i] is judges[i]'s): each criterion's points clamped to its
 * maximum and averaged across judges, the total normalised to 100, each distinct fix listed once. No I/O: the server
 * jury and a jury run by the user's own Claude (MCP) both go through it.
 */
export function aggregateVerdicts(input: {
  application: Pick<Application, "id" | "version">;
  criteria: readonly CallCriterion[];
  judges: JudgePersona[];
  verdicts: readonly JudgeVerdict[];
  estimated: boolean;
}): JuryScore {
  const { application, criteria: callCriteria, judges, verdicts, estimated } = input;
  const max = callCriteria.reduce((a, c) => a + c.maxPoints, 0) || 100;
  const seen = new Set<string>();
  const criteria = callCriteria.map((c, i) => {
    const byJudge = verdicts.map((v, j) => {
      const s = scoreFor(v, c, i, callCriteria.length);
      return { judgeId: judges[j].id, points: Math.max(0, Math.min(c.maxPoints, s?.points ?? 0)), comment: s?.comment ?? "" };
    });
    const points = Math.round((byJudge.reduce((a, b) => a + b.points, 0) / Math.max(1, byJudge.length)) * 10) / 10;
    // a fix proposed for two criteria is listed once (first criterion), so each checkbox is one distinct action
    const fixes = [...new Set(verdicts.flatMap((v) => scoreFor(v, c, i, callCriteria.length)?.fixes ?? []).map((f) => f.trim()).filter(Boolean))]
      .filter((f) => !seen.has(fold(f)))
      .slice(0, 3);
    fixes.forEach((f) => seen.add(fold(f)));
    return { criterionId: c.id, name: c.name, maxPoints: c.maxPoints, byJudge, points, fixes, ...(isVisualCriterion(c) ? { writtenOnly: true } : {}) };
  });
  const total = Math.max(0, Math.min(100, Math.round((criteria.reduce((a, c) => a + c.points, 0) / max) * 100)));
  const summary = [...new Set(verdicts.map((v) => v.overall).filter(Boolean))].join(" ");
  return {
    id: newId("score"),
    applicationId: application.id,
    applicationVersion: application.version,
    judges,
    criteria,
    total,
    summary,
    disclaimer: estimated ? DISCLAIMER_ESTIMATED : DISCLAIMER,
    estimated,
    createdAt: nowIso(),
  };
}

/**
 * Score the current version of an application. Concurrent calls for the same version share one scoring (and its
 * per-judge events), so prewarming on the draft page never doubles the cost of opening the jury.
 */
export function scoreApplication(applicationId: string, opts: { onJudge?: (e: JudgeEvent) => void } = {}): Promise<JuryScore> {
  const application = getApplication(applicationId);
  const key = `${application.id}@${application.version}`;
  let run = inflight.get(key);
  if (!run) {
    const entry: Inflight = { events: [], listeners: new Set(), promise: Promise.resolve(null as unknown as JuryScore) };
    entry.promise = runScoring(application, (e) => {
      entry.events.push(e);
      for (const l of entry.listeners) l(e);
    }).finally(() => inflight.delete(key));
    inflight.set(key, entry);
    run = entry;
  }
  if (opts.onJudge) {
    const listener = opts.onJudge;
    run.events.forEach(listener);
    run.listeners.add(listener);
    run.promise.finally(() => run.listeners.delete(listener)).catch(() => {});
  }
  return run.promise;
}

// ---- Client-side jury (MCP): the user's own Claude plays the judges, Mecena hands it the brief and scores the verdicts ----

/** The panel and criteria an application is judged with (same as the server jury). */
function panelFor(application: Application) {
  const rawCall = getCall(application.callId);
  const kind = getProfile(application.profileId).kind;
  const { criteria, estimated } = criteriaFor(rawCall, kind);
  return { rawCall, criteria, estimated, judges: judgesFor(kind) };
}

const CLIENT_JURY_FORMAT = `Haz de cada juez de "judges" por separado, con su perfil ("focus"), y escribe un veredicto por juez: {judgeId, scores: [{criterionId, points, comment, fixes}], overall}. Un "score" por cada criterio de "criteria", con su id exacto y puntos entre 0 y su "maxPoints". Los criterios con "writtenOnly" se valoran solo por lo escrito.
Después guarda los veredictos con save_jury_score, con el "applicationVersion" de esta solicitud (application.version). Mecena hace la media de los jueces y la normaliza a 100.`;

/** What a client model needs to run the jury itself (get_jury_brief). Without Pro, a run must be left (not used yet). */
export async function clientJuryBrief(applicationId: string, ctx: Pick<ToolContext, "appUserId">) {
  const application = getApplication(applicationId);
  const { rawCall, criteria, estimated, judges } = panelFor(application);
  const e = await resolveEntitlement(ctx.appUserId);
  const left = juryRunsLeft(e, application, { costsAi: false }); // the client model scores: no AI spent here
  if (left <= 0) throw new PaymentRequiredError(juryRunsMessage(juryRunLimit(e, application, { costsAi: false })));
  return {
    instructions: `${judgeSystem(estimated)}\n${CLIENT_JURY_FORMAT}`,
    judges,
    criteria: criteria.map((c) => ({ id: c.id, name: c.name, description: c.description, maxPoints: c.maxPoints, ...(isVisualCriterion(c) ? { writtenOnly: true } : {}) })),
    estimated,
    application,
    call: { id: rawCall.id, title: rawCall.title, summary: rawCall.summary, allowedExpenses: rawCall.allowedExpenses, maxAmountEur: rawCall.amountEur.max ?? null },
    works: listWorks(application.profileId).map((w) => w.sheet),
    runsLeft: Number.isFinite(left) ? left : null,
  };
}

/**
 * Score an application from verdicts a client model wrote (save_jury_score). They must be for the version it was
 * briefed on (else ConflictError) and come from the panel, one per judge (else BadRequestError). Scored exactly like
 * the server jury (aggregateVerdicts) and counted as one jury run without Pro.
 */
export async function saveClientScore(input: { applicationId: string; applicationVersion: number; verdicts: JudgeVerdict[] }, ctx: Pick<ToolContext, "appUserId">): Promise<JuryScore> {
  const application = getApplication(input.applicationId);
  if (input.applicationVersion !== application.version)
    throw new ConflictError(`La solicitud ha cambiado (ahora es la versión ${application.version}): vuelve a pedir get_jury_brief y puntúa la versión actual.`);
  const { criteria, estimated, judges } = panelFor(application);
  const byJudge = new Map(input.verdicts.map((v) => [v.judgeId.trim(), v]));
  const unknown = [...byJudge.keys()].filter((id) => !judges.some((j) => j.id === id));
  const missing = judges.filter((j) => !byJudge.has(j.id)).map((j) => j.id);
  if (unknown.length || missing.length || byJudge.size !== input.verdicts.length)
    throw new BadRequestError(`Necesito un veredicto por cada juez del tribunal (${judges.map((j) => j.id).join(", ")}), sin repetir ninguno.`);
  const verdicts = judges.map((j) => byJudge.get(j.id)!);
  return withJuryRun(ctx.appUserId, application.id, () => saveJuryScore(aggregateVerdicts({ application, criteria, judges, verdicts, estimated })), { costsAi: false });
}

/** The score of the current version if there is one (no AI call), otherwise score it (or join the scoring in flight). */
export async function ensureScore(applicationId: string, opts: { onJudge?: (e: JudgeEvent) => void } = {}): Promise<{ score: JuryScore; cached: boolean }> {
  const application = getApplication(applicationId);
  const latest = latestJuryScore(applicationId);
  if (latest && latest.applicationVersion === application.version) return { score: latest, cached: true };
  return { score: await scoreApplication(applicationId, opts), cached: false };
}

const snapshot = (a: Application): ApplicationSnapshot => ({
  version: a.version,
  status: a.status,
  sections: a.sections,
  budget: a.budget,
  checklist: a.checklist,
  ...(a.revision ? { revision: a.revision } : {}),
});

export interface ImproveInput {
  applicationId: string;
  scoreId: string;
  fixes?: string[];
  facts?: UserFact[];
}

/**
 * Apply the accepted fixes of one jury score (only fixes that score proposed; facts only for accepted fixes) and save
 * the revised draft, keeping the previous version for "Deshacer". Idempotent: if this score's fixes were already
 * applied to the current version (e.g. the re-score failed), nothing is revised again.
 */
export async function reviseFromScore(input: ImproveInput): Promise<{ application: Application; previous: JuryScore; alreadyRevised: boolean }> {
  const application = getApplication(input.applicationId);
  const previous = listJuryScores(application.id).find((s) => s.id === input.scoreId);
  if (!previous) throw new ConflictError("Esa puntuación ya no está: vuelve a pasar el tribunal.");
  if (application.revision?.fromScoreId === previous.id && application.revision.version === application.version) return { application, previous, alreadyRevised: true };
  if (previous.applicationVersion !== application.version) throw new ConflictError("Has cambiado la solicitud desde esta puntuación: vuelve a pasar el tribunal antes de aplicar mejoras.");

  const proposed = [...new Set(previous.criteria.flatMap((c) => c.fixes))];
  const allowed = new Set(proposed);
  const fixes = [...new Set((input.fixes ?? proposed).map((f) => f.trim()))].filter((f) => allowed.has(f));
  if (!fixes.length) throw new ConflictError("Marca al menos una de las mejoras que propone el tribunal.");
  const facts = (input.facts ?? [])
    .map((f) => ({ fix: f.fix.trim(), text: f.text.trim().slice(0, 300) }))
    .filter((f, i, all) => f.text && fixes.includes(f.fix) && all.findIndex((x) => x.fix === f.fix) === i);

  const rawCall = getCall(application.callId);
  const kind = getProfile(application.profileId).kind;
  const call = { ...rawCall, criteria: criteriaFor(rawCall, kind).criteria };
  const weakest = [...previous.criteria]
    .sort((a, b) => a.points / a.maxPoints - b.points / b.maxPoints)
    .slice(0, 3)
    .map((c) => ({ name: c.name, points: c.points, maxPoints: c.maxPoints, comments: [...new Set(c.byJudge.map((j) => j.comment).filter(Boolean))] }));

  const ai = getAi();
  const t0 = performance.now();
  const revised = await ai.reviseApplication({ call, application, transcript: getTranscript(application.profileId), fixes, facts, weakest, works: listWorks(application.profileId) });
  console.info(`[jury] ${application.id} revised v${application.version} (${ai.mode}, ${fixes.length} fixes, ${facts.length} facts) in ${ms(t0)}`);
  const version = application.version + 1;
  const next = await saveApplication({
    ...application,
    sections: revised.sections,
    budget: application.budget, // the user's budget is never rewritten by the jury
    checklist: application.checklist,
    version,
    status: "reviewed",
    revision: { fromScoreId: previous.id, version, fixes, proposed: proposed.length, baseTotal: previous.total, facts },
    previous: snapshot(application),
    updatedAt: nowIso(),
  });
  return { application: next, previous, alreadyRevised: false };
}

/** Revise and re-score in one call (MCP, tests). The UI does the two steps separately to show progress per judge. */
export async function improveApplication(input: ImproveInput): Promise<{ application: Application; score: JuryScore; previous?: JuryScore }> {
  const { application, previous } = await reviseFromScore(input);
  const { score } = await ensureScore(application.id);
  return { application: getApplication(application.id), score, previous };
}

/**
 * "Deshacer mejoras": put back the draft from before the last improvement (as a new version) and its score, copied
 * without calling the judges again (same text, same score).
 */
export async function undoImprovement(applicationId: string): Promise<{ application: Application; score: JuryScore | null }> {
  const app = getApplication(applicationId);
  const prev = app.previous;
  if (!prev) throw new ConflictError("No hay mejoras que deshacer.");
  const restored = await saveApplication({
    ...app,
    sections: prev.sections,
    budget: prev.budget,
    checklist: app.checklist, // ticks made since stay ticked
    status: prev.status,
    revision: prev.revision,
    previous: undefined,
    version: app.version + 1,
    updatedAt: nowIso(),
  });
  const old = listJuryScores(applicationId)
    .filter((s) => s.applicationVersion === prev.version)
    .at(-1);
  const score = old ? await saveJuryScore({ ...old, id: newId("score"), applicationVersion: restored.version, createdAt: nowIso() }) : null;
  return { application: restored, score };
}
