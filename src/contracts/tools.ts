/**
 * The Mecena tools. ONE definition, two front doors with different tool sets:
 *  - the in-app agent (/api/agent) passes AGENT_TOOL_NAMES to Claude as tools: it runs on Mecena's server-side key,
 *    so drafting and the jury run on Mecena's AI (draft_application, score_application);
 *  - the MCP server registers MCP_TOOL_NAMES for Claude Desktop / Claude Code / claude.ai: remote over Streamable HTTP
 *    (POST /api/mcp, personal token) or local over stdio (src/mcp/server.ts). There the user's own Claude does the
 *    writing and the judging: Mecena hands it the context (get_application_context, get_jury_brief) and checks and
 *    saves what it wrote (save_application_draft, save_jury_score). No MCP tool calls Mecena's AI (ADR-026).
 * Handlers live in src/tools/registry.ts and delegate to feature services.
 */
import { z } from "zod";
import { Application, ApplicationSection, BudgetLine, Call, ChecklistItem, Dossier, JudgePersona, JuryScore, MatchResult, Profile, ProfileKind, ProfilePatch, TechnicalSheet } from "./domain";
import { JudgeVerdict } from "./ai";

/** The tools the in-app agent offers its (server-side) model. */
export const AGENT_TOOL_NAMES = [
  "get_profile",
  "update_profile",
  "build_dossier",
  "export_dossier_pdf",
  "search_calls",
  "explain_call",
  "draft_application",
  "score_application",
] as const;

/** The tools the MCP server exposes: the same data tools, and client-side drafting and jury instead of server AI. */
export const MCP_TOOL_NAMES = [
  "get_profile",
  "update_profile",
  "build_dossier",
  "export_dossier_pdf",
  "search_calls",
  "explain_call",
  "get_application_context",
  "save_application_draft",
  "get_jury_brief",
  "save_jury_score",
] as const;

export const TOOL_NAMES = [...AGENT_TOOL_NAMES, "get_application_context", "save_application_draft", "get_jury_brief", "save_jury_score"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** A transcript fragment in the user's own words: `id` is what sections cite in sourceSegmentIds. */
const OwnWords = z.object({ id: z.string(), text: z.string() });

/** Bounds on what a client model may save (the text is stored as the user's draft). */
const SectionIn = ApplicationSection.extend({
  key: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  sourceSegmentIds: z.array(z.string().max(80)).max(200).default([]),
});
const JudgeVerdictIn = JudgeVerdict.extend({
  judgeId: z.string().max(80),
  scores: z
    .array(z.object({ criterionId: z.string().max(80), points: z.number(), comment: z.string().max(1_000), fixes: z.array(z.string().max(500)).max(5) }))
    .max(30),
  overall: z.string().max(1_000),
});

const profileIdIn = z.string().optional().describe("Profile id. Omit to use the user's active profile (recommended).");

export const toolSchemas = {
  get_profile: {
    description: "Get the user's Mecena profile (artist or small business): who they are, disciplines/sector, achievements, funding needs.",
    input: z.object({ profileId: profileIdIn }),
    output: z.object({ profile: Profile }),
  },
  update_profile: {
    description:
      "Update fields of the user's profile. Arrays are merged. Never invent facts the user did not state. Write their words without their typos: fix spelling, accents and dictation slips, keep their wording, names and language (Galician stays Galician).",
    input: z.object({ profileId: profileIdIn, patch: ProfilePatch }),
    output: z.object({ profile: Profile }),
  },
  build_dossier: {
    description:
      "Build the user's dossier (artistic portfolio for creators, capability memoria for businesses). With callId, adapt it to that call's requirements (image limits, ordering, texts for its criteria): the adaptation is a Mecena Pro feature; without Pro the general dossier is returned with the call's notes as a preview.",
    input: z.object({ profileId: profileIdIn, callId: z.string().optional() }),
    // adapted: the dossier (and the page at url) really is the call variant (callId given and the user is Pro).
    output: z.object({ dossier: Dossier, url: z.string(), adapted: z.boolean() }),
  },
  export_dossier_pdf: {
    description:
      "Export the dossier as a PDF and return its download URL (it opens with the user's Mecena session). With callId and Mecena Pro, the PDF is the version adapted to that call; without Pro, the general dossier.",
    input: z.object({ profileId: profileIdIn, callId: z.string().optional() }),
    // sizeMb/note: the real file size and, for a call with a size limit, whether it fits (and if photos were reduced).
    // adapted: the PDF at url is the call version; callId: the call it was asked for (adapted or not).
    output: z.object({
      url: z.string(),
      pages: z.number().int().optional(),
      sizeMb: z.number().optional(),
      note: z.string().optional(),
      adapted: z.boolean(),
      callId: z.string().optional(),
    }),
  },
  search_calls: {
    description:
      "Find open or upcoming calls (convocatorias, becas, premios, residencias, subvenciones) the user fits, ranked, with why they fit and what they are missing. The free plan sees its top 3 matches; lockedCount says how many more Mecena Pro unlocks.",
    input: z.object({
      profileId: profileIdIn,
      query: z.string().optional().describe("Free text filter, e.g. 'residencia', 'digitalización'"),
      kind: ProfileKind.optional(),
      limit: z.number().int().min(1).max(25).optional(),
      includeClosed: z.boolean().optional().describe("Also return recurring calls whose current edition already closed (default false: only open and upcoming)."),
    }),
    output: z.object({
      results: z.array(z.object({ call: Call, match: MatchResult })),
      /** Further matches the free plan does not show (0 with Pro). */
      lockedCount: z.number().int().min(0),
      pro: z.boolean(),
      /** Recurring/closed matches left out because includeClosed was not set. */
      closedCount: z.number().int().min(0),
    }),
  },
  explain_call: {
    description:
      "Explain a call's bases in plain Spanish: who can apply, amount, deadline, documents, scoring criteria, and the user's fit. On the free plan, only for the user's top 3 matches (the ones search_calls shows).",
    input: z.object({ callId: z.string(), profileId: profileIdIn }),
    output: z.object({ call: Call, match: MatchResult, checklist: z.array(z.string()) }),
  },
  draft_application: {
    description:
      "Draft the application (memoria, statement or company text, budget, checklist) for a call, written from the user's own words. Requires Pro or a Solicitud premium credit. Mecena prepares; the user submits.",
    input: z.object({ callId: z.string(), profileId: profileIdIn }),
    output: z.object({ application: Application, url: z.string() }),
  },
  score_application: {
    description:
      "Run the simulated jury: several judges score the draft with the call's official criteria and weights and suggest concrete fixes. Orientative only.",
    input: z.object({ applicationId: z.string() }),
    output: z.object({ score: JuryScore, url: z.string() }),
  },
  get_application_context: {
    description:
      "Get everything you need to write the application for a call YOURSELF: writing rules (instructions), the user's profile, their own words (transcript fragments with ids), their works' technical sheets, the call's criteria, allowed expenses, maximum amount and required documents, and the current draft if there is one. Write the draft following the instructions, then save it with save_application_draft. A new draft requires Mecena Pro or a Solicitud premium credit (the credit is used when you save).",
    input: z.object({ callId: z.string(), profileId: profileIdIn }),
    output: z.object({
      instructions: z.string(),
      sectionKeys: z.array(z.string()),
      needsBudget: z.boolean(),
      profile: Profile,
      transcript: z.array(OwnWords),
      works: z.array(TechnicalSheet),
      call: Call,
      existing: Application.optional(),
    }),
  },
  save_application_draft: {
    description:
      "Save the application you wrote (after get_application_context) as the user's draft for that call. Mecena checks it: budget lines must use the call's allowed expense types and stay under its maximum (otherwise you get the reason, fix it and save again), sourceSegmentIds must be ids from the transcript, and the checklist is rebuilt from the call's required documents. Saving over an existing draft creates a new version. Saving a first draft uses Mecena Pro or one Solicitud premium credit.",
    input: z.object({
      callId: z.string(),
      profileId: profileIdIn,
      sections: z.array(SectionIn).min(1).max(12),
      budget: z.array(BudgetLine.extend({ concept: z.string().min(1).max(200), expenseType: z.string().max(200), note: z.string().max(500).optional() })).max(30).default([]),
      checklist: z.array(ChecklistItem.extend({ item: z.string().max(500), hint: z.string().max(500).optional() })).max(40).optional(),
    }),
    output: z.object({ application: Application, url: z.string(), created: z.boolean() }),
  },
  get_jury_brief: {
    description:
      "Get what you need to run the simulated jury YOURSELF on a saved application: scoring rules (instructions), the panel of judges (each with a focus), the call's criteria with ids and maximum points, the application's current text and version, and the works' technical sheets. Write one verdict per judge, in their role, then save them with save_jury_score. Orientative only. Without Mecena Pro each application includes a limited number of jury runs (runsLeft).",
    input: z.object({ applicationId: z.string() }),
    output: z.object({
      instructions: z.string(),
      judges: z.array(JudgePersona),
      criteria: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), maxPoints: z.number(), writtenOnly: z.boolean().optional() })),
      estimated: z.boolean(),
      application: Application,
      call: z.object({ id: z.string(), title: z.string(), summary: z.string(), allowedExpenses: z.array(z.string()), maxAmountEur: z.number().nullable() }),
      works: z.array(TechnicalSheet),
      /** Jury runs left for this application without Pro; null with Pro (unlimited). */
      runsLeft: z.number().int().min(0).nullable(),
    }),
  },
  save_jury_score: {
    description:
      "Save the simulated jury you ran (after get_jury_brief): one verdict per judge of the panel (judgeId), with a score for every criterion (criterionId = its exact id, points between 0 and its maximum), a one-line comment and 1-2 concrete fixes. applicationVersion must be the version get_jury_brief returned. Mecena clamps the points, averages the judges, normalises to 100 and shows the result on the jury page. Uses one jury run without Pro.",
    input: z.object({
      applicationId: z.string(),
      applicationVersion: z.number().int().min(1),
      verdicts: z.array(JudgeVerdictIn).min(1).max(6),
    }),
    output: z.object({ score: JuryScore, url: z.string() }),
  },
} as const satisfies Record<ToolName, { description: string; input: z.ZodObject; output: z.ZodObject }>;

export type ToolInput<N extends ToolName> = z.infer<(typeof toolSchemas)[N]["input"]>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof toolSchemas)[N]["output"]>;

/**
 * Who is calling a tool, resolved on the server: the session cookie for the app, the personal MCP token for the
 * remote MCP endpoint, MECENA_USER_EMAIL for the local stdio server.
 * Tools only touch this user's data: a profileId in the input must be one of theirs, and entitlements always
 * come from `appUserId` (never from the model or the client).
 */
export interface ToolContext {
  /** app: in-app agent; mcp: local stdio server (its own data dir); mcp-remote: /api/mcp on the deployed app. */
  caller: "app" | "mcp" | "mcp-remote";
  userId: string;
  /** The user's active profile: used when a tool input omits profileId. */
  profileId: string;
  /** RevenueCat app user id of this user. */
  appUserId: string;
}

export type ToolHandler<N extends ToolName> = (input: ToolInput<N>, ctx: ToolContext) => Promise<ToolOutput<N>>;
export type ToolHandlers = { [N in ToolName]: ToolHandler<N> };

/** Thrown by draft_application when the user has no entitlement. Routes map it to HTTP 402. */
export class PaymentRequiredError extends Error {
  constructor(message = "Necesitas Mecena Pro o una Solicitud premium") {
    super(message);
    this.name = "PaymentRequiredError";
  }
}

/** What a 404 is about. Each has its own user-facing message (right gender, never the internal id). */
export type NotFoundKind = "profile" | "work" | "image" | "call" | "application" | "user" | "research" | "invoice";

const NOT_FOUND_MESSAGES: Record<NotFoundKind, string> = {
  profile: "No encontramos este perfil.",
  work: "No encontramos esta obra.",
  image: "No encontramos esta imagen.",
  call: "No encontramos esta convocatoria.",
  application: "No encontramos esta solicitud.",
  user: "No encontramos tu cuenta.",
  research: "No encontramos esta búsqueda ampliada.",
  invoice: "No encontramos esta factura.",
};

/** Older call sites pass a label such as `Convocatoria ${id}`: map its first word to a kind (the id is dropped). */
const LEGACY_LABELS: [RegExp, NotFoundKind][] = [
  [/^perfil\b/i, "profile"],
  [/^obra\b/i, "work"],
  [/^imagen\b/i, "image"],
  [/^convocatoria\b/i, "call"],
  [/^solicitud\b/i, "application"],
  [/^usuario\b/i, "user"],
  [/^b[uú]squeda\b/i, "research"],
  [/^factura\b/i, "invoice"],
];

/** 404. The message is safe to show: per-kind Spanish text, without ids. */
export class NotFoundError extends Error {
  readonly kind: NotFoundKind | undefined;
  constructor(what: NotFoundKind | string) {
    const kind = what in NOT_FOUND_MESSAGES ? (what as NotFoundKind) : LEGACY_LABELS.find(([re]) => re.test(what.trim()))?.[1];
    super(kind ? NOT_FOUND_MESSAGES[kind] : "No encontramos lo que buscas.");
    this.name = "NotFoundError";
    this.kind = kind;
  }
}

/** Invalid request body (too large, truncated, not JSON, or fails its schema). Routes map it to HTTP 400 (413 when too large). */
export class BadRequestError extends Error {
  constructor(message = "Revisa los datos e inténtalo de nuevo.", readonly status: 400 | 413 = 400) {
    super(message);
    this.name = "BadRequestError";
  }
}

/** No (valid) session. Routes map it to HTTP 401 { error: "unauthorized" }. */
export class UnauthorizedError extends Error {
  constructor(message = "Inicia sesión para continuar.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Signed in, but not allowed (e.g. a wrong invite code). Routes map it to HTTP 403. */
export class ForbiddenError extends Error {
  constructor(message = "No tienes permiso para hacer esto.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** The resource already exists (e.g. an account with that email). Routes map it to HTTP 409. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Too many attempts (login/signup rate limit). Routes map it to HTTP 429. */
export class TooManyRequestsError extends Error {
  constructor(message = "Demasiados intentos. Espera unos minutos y vuelve a probar.") {
    super(message);
    this.name = "TooManyRequestsError";
  }
}
