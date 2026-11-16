/**
 * Presentation layer shared by both front doors (MCP server and in-app agent):
 * a short Spanish (Spain) summary of each tool result, the JSON Schema of each tool's input
 * and a user-facing message for each error type.
 */
import { ZodError, z } from "zod";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentRequiredError,
  ROUTES,
  serverEnv,
  TooManyRequestsError,
  toolSchemas,
  UnauthorizedError,
  type Call,
  type ToolContext,
  type ToolName,
  type ToolOutput,
} from "@/contracts";
import { AiBudgetError, AiError, AiUnavailableError } from "@/server/ai/llm";
import { listCalls } from "@/server/store";

const base = () => serverEnv().publicUrl;

export const pricingUrl = () => `${base()}${ROUTES.pricing}`;
export const callUrl = (callId: string) => `${base()}${ROUTES.call(callId)}`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const callTitle = (callId: string) => listCalls().find((c) => c.id === callId)?.title.replace(/^\[FIXTURE\]\s*/, "") ?? callId;

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
};

/** The year a recurring call should open again: the edition that closed + 1 (from its text, deadline or id). */
function nextEditionYear(call: Call): number | undefined {
  const fromText = /edici[oó]n\s+(\d{4})/i.exec(call.deadlineText)?.[1] ?? call.deadline?.slice(0, 4) ?? /(\d{4})$/.exec(call.id)?.[1];
  return fromText ? Number(fromText) + 1 : undefined;
}

/** Whether you can apply now, in a few words: "abierta", "abre el 16/04/2027", "cerrada; abre de nuevo en 2027". */
export function callStatusText(call: Call): string {
  switch (call.status) {
    case "open":
      return "abierta";
    case "upcoming":
      return call.opensAt ? `abre el ${fmtDate(call.opensAt)}` : "abre pronto";
    case "recurring": {
      const year = nextEditionYear(call);
      return year ? `cerrada; abre de nuevo en ${year}` : "cerrada; se convoca cada año";
    }
    case "closed":
      return "cerrada";
  }
}

const proNote = (what: string) => `${what} es de Mecena Pro (o de una Solicitud premium para esta convocatoria): ${pricingUrl()}`;

type Summarizers = { [N in ToolName]: (out: ToolOutput<N>) => string };

const summarizers: Summarizers = {
  get_profile: ({ profile }) => {
    const who = profile.displayName || "Perfil sin nombre todavía";
    const kind = profile.kind === "creator" ? "creador/a" : "pyme o autónomo";
    const place = [profile.city, profile.region].filter(Boolean).join(", ");
    const tags = profile.kind === "creator" ? profile.disciplines : [profile.sector].filter(Boolean);
    return [`${who} (${kind}${place ? `, ${place}` : ""}).`, tags.length ? `Ámbito: ${tags.join(", ")}.` : "", profile.achievements.length ? `${plural(profile.achievements.length, "logro registrado", "logros registrados")}.` : ""]
      .filter(Boolean)
      .join(" ");
  },
  update_profile: ({ profile }) => `Perfil actualizado: ${profile.displayName || "sin nombre todavía"}.`,
  build_dossier: ({ dossier, url, adapted }) => {
    const what = dossier.kind === "creator" ? "Dossier artístico" : "Memoria de capacidades";
    const done = `${what} listo: ${plural(dossier.sections.length, "sección", "secciones")} y ${plural(dossier.workIds.length, "obra", "obras")}.`;
    const callId = dossier.variant?.callId;
    if (!callId) return `${done} Ábrelo aquí: ${url}`;
    const title = callTitle(callId);
    if (adapted) {
      const max = dossier.variant?.maxImages ? ` (máximo ${dossier.variant.maxImages} imágenes)` : "";
      return `${done} Adaptado a la convocatoria «${title}»${max}. Ábrelo aquí: ${url}`;
    }
    return `${done} Es tu dossier general, con las notas de «${title}» como vista previa. ${proNote("Adaptarlo a esta convocatoria (orden, límite de imágenes y textos según sus criterios)")}. Ábrelo aquí: ${url}`;
  },
  export_dossier_pdf: ({ url, pages, adapted, callId, note }) => {
    const size = pages ? ` (${plural(pages, "página", "páginas")})` : "";
    const tail = note ? ` ${note}` : "";
    if (callId && adapted) return `PDF del dossier adaptado a «${callTitle(callId)}» generado${size}. Descárgalo aquí (con tu sesión de Mecena): ${url}${tail}`;
    const pro = callId ? ` Es tu dossier general: ${proNote(`la versión adaptada a «${callTitle(callId)}»`)}.` : "";
    return `PDF del dossier generado${size}.${pro} Descárgalo aquí (con tu sesión de Mecena): ${url}${tail}`;
  },
  search_calls: ({ results, lockedCount, pro, closedCount }) => {
    const tail = [
      !pro && lockedCount > 0 ? `Tienes ${lockedCount} más con Mecena Pro: ${pricingUrl()}` : "",
      closedCount > 0 ? `Hay ${plural(closedCount, "convocatoria recurrente que también encaja pero cuya edición de este año ya cerró", "convocatorias recurrentes que también encajan pero cuya edición de este año ya cerró")}; pídemelas si quieres verlas.` : "",
    ].filter(Boolean);
    if (!results.length) {
      const head =
        !pro && lockedCount > 0
          ? "Tus convocatorias destacadas del plan gratuito no coinciden con esta búsqueda."
          : "No he encontrado convocatorias abiertas o próximas que encajen con tu perfil ahora mismo.";
      return [head, ...tail].join("\n");
    }
    const lines = results.map(
      ({ call, match }, i) =>
        `${i + 1}. ${call.title} (${call.organizer}) · ${callStatusText(call)} · ${call.amountText} · plazo: ${call.deadlineText} · encaje ${Math.round(match.score)}/100 · ${callUrl(call.id)}`,
    );
    const onlyApplicable = results.every(({ call }) => call.status === "open" || call.status === "upcoming");
    const what = plural(results.length, onlyApplicable ? "convocatoria abierta o próxima que encaja" : "convocatoria que encaja", onlyApplicable ? "convocatorias abiertas o próximas que encajan" : "convocatorias que encajan");
    return [`He encontrado ${what} contigo:`, ...lines, ...tail].join("\n");
  },
  explain_call: ({ call, match, checklist }) =>
    [
      `${call.title} (${call.organizer}) · ${callStatusText(call)}.`,
      `Cuantía: ${call.amountText}. Plazo: ${call.deadlineText}.`,
      call.summary,
      match.whyYouFit.length ? `Por qué encajas: ${match.whyYouFit.join("; ")}.` : "",
      match.whatYouMiss.length ? `Qué te falta: ${match.whatYouMiss.join("; ")}.` : "",
      checklist.length ? `Documentación: ${checklist.join("; ")}.` : "",
      `Más información: ${callUrl(call.id)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  draft_application: ({ application, url }) =>
    `Borrador de solicitud listo (versión ${application.version}): ${plural(application.sections.length, "apartado", "apartados")}, ${plural(application.budget.length, "partida", "partidas")} de presupuesto y ${plural(application.checklist.length, "punto", "puntos")} de checklist. Mecena prepara; tú presentas. Revísalo aquí: ${url}`,
  score_application: ({ score, url }) => juryLine(score, url),
  get_application_context: ({ call, profile, transcript, works, existing, sectionKeys }) =>
    [
      `Contexto para redactar la solicitud de «${call.title}» (${call.organizer}) · ${callStatusText(call)} · plazo: ${call.deadlineText}.`,
      `Tienes el perfil de ${profile.displayName || "la persona"}, ${plural(transcript.length, "fragmento", "fragmentos")} con sus propias palabras, ${plural(works.length, "ficha", "fichas")} de obra y ${plural(call.criteria.length, "criterio", "criterios")} de valoración.`,
      existing ? `Ya hay un borrador (versión ${existing.version}): si guardas, será la versión ${existing.version + 1}.` : "",
      `Redáctala siguiendo "instructions" (apartados: ${sectionKeys.join(", ")}) y guárdala con save_application_draft.`,
    ]
      .filter(Boolean)
      .join("\n"),
  save_application_draft: ({ application, url, created }) =>
    `${created ? "Borrador de solicitud guardado" : `Solicitud actualizada a la versión ${application.version}`}: ${plural(application.sections.length, "apartado", "apartados")}, ${plural(application.budget.length, "partida", "partidas")} de presupuesto y ${plural(application.checklist.length, "punto", "puntos")} de checklist. Mecena prepara; tú presentas. Revísalo aquí: ${url}`,
  get_jury_brief: ({ judges, criteria, application, call, runsLeft }) =>
    [
      `Tribunal simulado para la solicitud de «${call.title}» (versión ${application.version}): ${plural(judges.length, "juez", "jueces")} (${judges.map((j) => j.name).join(", ")}) y ${plural(criteria.length, "criterio", "criterios")}.`,
      runsLeft === null ? "" : `Le ${runsLeft === 1 ? "queda" : "quedan"} ${plural(runsLeft, "pasada", "pasadas")} por el tribunal sin Mecena Pro.`,
      `Escribe un veredicto por juez siguiendo "instructions" y guárdalos con save_jury_score (applicationVersion ${application.version}).`,
    ]
      .filter(Boolean)
      .join("\n"),
  save_jury_score: ({ score, url }) => juryLine(score, url),
};

function juryLine(score: ToolOutput<"score_application">["score"], url: string): string {
  const crit = score.criteria.map((c) => `${c.name}: ${Math.round(c.points)}/${c.maxPoints}`).join("; ");
  return `El tribunal simulado le da ${score.total}/100.${crit ? ` ${crit}.` : ""} ${score.disclaimer} Detalle y mejoras: ${url}`;
}

/** One short Spanish line (or a few) a human can read, for any tool output. */
export function summarizeToolResult<N extends ToolName>(name: N, output: ToolOutput<N>): string {
  return (summarizers[name] as (o: ToolOutput<N>) => string)(output);
}

const DRAFT_PAYWALL = new PaymentRequiredError().message;

/**
 * Where a purchase counts, per front door. The app and the remote MCP endpoint read the same account on the same
 * server, so a purchase made on the phone unlocks them. The local stdio server reads the data dir of the machine it
 * runs on: only purchases made in the web app that uses that same data dir count there.
 */
function unlockNote(caller: ToolContext["caller"] | undefined): string {
  if (caller === "mcp-remote") return " La compra se guarda en tu cuenta de Mecena: en cuanto la hagas (también desde el móvil), vuelve a pedírmelo.";
  if (caller === "mcp")
    return " Ojo: este servidor MCP local lee los datos de este ordenador, así que la compra solo cuenta aquí si la haces en la web que usa esos mismos datos. Para usar tu cuenta de la app publicada, conecta Claude por el MCP remoto (en la web: Cuenta → Conectar con Claude).";
  return "";
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

/** User-facing Spanish message for an error thrown by a tool. `caller` tailors where a purchase counts. */
export function toolErrorMessage(e: unknown, caller?: ToolContext["caller"]): string {
  if (e instanceof PaymentRequiredError) {
    const what = e.message === DRAFT_PAYWALL ? `${DRAFT_PAYWALL} para preparar la solicitud` : e.message;
    return `${sentence(what)} Desbloquéalo aquí: ${pricingUrl()}${unlockNote(caller)}`;
  }
  if (e instanceof ZodError) return `Datos de entrada no válidos: ${e.issues.map((i) => `${i.path.join(".") || "(entrada)"}: ${i.message}`).join("; ")}`;
  if (e instanceof NotFoundError) return sentence(e.message.charAt(0).toUpperCase() + e.message.slice(1));
  if (e instanceof UnauthorizedError || e instanceof ForbiddenError || e instanceof ConflictError || e instanceof TooManyRequestsError || e instanceof BadRequestError) return e.message;
  if (e instanceof AiBudgetError || e instanceof AiUnavailableError) return e.message;
  if (e instanceof AiError) return "La IA no ha podido completar esta tarea ahora mismo. Inténtalo de nuevo en unos segundos.";
  return "Algo ha fallado al ejecutar esta herramienta. Inténtalo de nuevo en unos segundos.";
}

/** Errors a tool throws on purpose (paywall, not found, bad input…): no need to log them as failures. */
export function isExpectedToolError(e: unknown): boolean {
  return [PaymentRequiredError, NotFoundError, UnauthorizedError, ForbiddenError, ConflictError, TooManyRequestsError, BadRequestError, AiError, ZodError].some((C) => e instanceof C);
}

/** JSON Schema (draft 2020-12) of a tool's input, for Claude's `tools[].input_schema`. */
export function toolInputJsonSchema(name: ToolName): { type: "object"; properties?: unknown; required?: string[]; [k: string]: unknown } {
  const schema = z.toJSONSchema(toolSchemas[name].input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return { ...schema, type: "object" };
}
