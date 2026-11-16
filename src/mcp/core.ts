/**
 * The Mecena MCP server definition, shared by both transports (no side effects, safe to import from Next):
 * the remote Streamable HTTP endpoint (./http.ts, POST /api/mcp) and the local stdio server (./server.ts).
 * Its tools (MCP_TOOL_NAMES) come from the same module as the in-app agent's (src/tools), but nothing here runs on
 * Mecena's AI: the user's own Claude writes the drafts and plays the jury (get_application_context →
 * save_application_draft, get_jury_brief → save_jury_score), and every call runs with the AI forced to the
 * deterministic mocks as a safety net (ADR-026), so an MCP client never spends the server's Anthropic key.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOL_NAMES, serverEnv, toolSchemas, UnauthorizedError, type ToolContext, type ToolName } from "@/contracts";
import { runWithAiSwitches } from "@/features/demo/ai-mode";
import { findUserByEmail, toolContextFor } from "@/server/auth";
import { runTool } from "@/tools/registry";
import { summarizeToolResult, toolErrorMessage } from "@/tools/present";

export const MCP_INSTRUCTIONS = [
  "Mecena ayuda a artistas, ilustradores, fotógrafos, pymes y autónomos con el papeleo de convocatorias, becas, premios y subvenciones.",
  "Mecena prepara; la persona usuaria revisa y presenta. Nunca inventes datos del perfil que no haya dicho.",
  "Flujo típico: search_calls → explain_call → build_dossier (con callId) → export_dossier_pdf → get_application_context → save_application_draft → get_jury_brief → save_jury_score.",
  "Tú redactas la solicitud y haces de tribunal: Mecena te da el contexto y las reglas (get_application_context, get_jury_brief), y comprueba y guarda lo que escribes (save_application_draft, save_jury_score). Sigue sus instrucciones al pie de la letra y escribe solo con los datos y las palabras de la persona.",
  "explain_call te da las bases y el encaje calculado por reglas: explícaselas tú con claridad.",
  "Cada herramienta devuelve un resumen en español y después el JSON completo. Comparte siempre los enlaces (url) con la persona usuaria: se abren con su sesión de Mecena.",
  "Si una herramienta pide Mecena Pro, explícalo con amabilidad y comparte el enlace de pago; no intentes rodearlo con otras herramientas.",
].join(" ");

type RunFn = (name: ToolName, input: unknown, ctx: ToolContext) => Promise<unknown>;

export interface McpServerOptions {
  /** Tool runner; tests can inject a fake. Defaults to the shared registry. */
  run?: RunFn;
  /** Account email the tools act as (stdio). Defaults to MECENA_USER_EMAIL. Ignored when `context` is given. */
  userEmail?: string;
  /**
   * Who the tools run as, resolved before every call (remote endpoint: the token's user). Defaults to the
   * MECENA_USER_EMAIL account (stdio). May throw (e.g. a rate limit): the call becomes a Spanish isError result.
   */
  context?: () => Promise<ToolContext>;
}

/**
 * The tool context for the configured account, read fresh on every call (so a mode switch in the web app, or a
 * purchase, is seen by the next MCP call).
 */
export async function mcpToolContext(email = serverEnv().mcpUserEmail): Promise<ToolContext> {
  if (!email) throw new UnauthorizedError("Configura MECENA_USER_EMAIL con el email de tu cuenta de Mecena (ver docs/mcp.md).");
  const user = findUserByEmail(email);
  if (!user) throw new UnauthorizedError(`No hay ninguna cuenta de Mecena con el email ${email}. Crea la cuenta en la web primero.`);
  return toolContextFor(user, "mcp");
}

/** Text content blocks returned for a tool call: [human summary, JSON]. */
export async function callToolForMcp(name: ToolName, args: unknown, run: RunFn = runTool, context: () => Promise<ToolContext> = () => mcpToolContext()) {
  // Safety net: whatever a tool calls underneath, over MCP it never reaches the Anthropic API (the deterministic
  // versions answer instead), so connecting Claude to Mecena costs the server nothing in AI.
  return runWithAiSwitches({ aiMock: true }, () => callTool(name, args, run, context));
}

async function callTool(name: ToolName, args: unknown, run: RunFn, context: () => Promise<ToolContext>) {
  let caller: ToolContext["caller"] = "mcp";
  try {
    const ctx = await context();
    caller = ctx.caller;
    const out = await run(name, args, ctx);
    return {
      content: [
        { type: "text" as const, text: summarizeToolResult(name, out as never) },
        { type: "text" as const, text: JSON.stringify(out, null, 2) },
      ],
    };
  } catch (e) {
    console.error(`[mecena-mcp] ${name} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return { isError: true, content: [{ type: "text" as const, text: toolErrorMessage(e, caller) }] };
  }
}

export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "mecena", version: "0.1.0" }, { instructions: MCP_INSTRUCTIONS });
  const context = opts.context ?? (() => mcpToolContext(opts.userEmail));
  spanishInputValidation(server);
  for (const name of MCP_TOOL_NAMES) {
    const def = toolSchemas[name];
    server.registerTool(name, { description: def.description, inputSchema: def.input.shape }, async (args: unknown) => callToolForMcp(name, args, opts.run, context));
  }
  return server;
}

const spanishErrors = z.locales.es().localeError;

/**
 * The SDK validates tool arguments before our handler runs and reports failures in English ("Input validation
 * error…"). Swap its (private) validator for the same schemas with Spanish messages, so Claude relays Spanish.
 */
function spanishInputValidation(server: McpServer) {
  const validate = async (_tool: unknown, args: unknown, toolName: string) => {
    const schema = (toolSchemas as Record<string, { input: z.ZodObject }>)[toolName]?.input;
    if (!schema) return args;
    const r = schema.safeParse(args ?? {}, { error: spanishErrors });
    if (!r.success) throw new Error(toolErrorMessage(r.error));
    return r.data;
  };
  Object.assign(server as unknown as Record<string, unknown>, { validateToolInput: validate });
}
