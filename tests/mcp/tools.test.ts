/** WP-04: the MCP front door, end to end over an in-memory transport, on AI mocks. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { JURY_RUNS_PER_APPLICATION, MCP_TOOL_NAMES, toolSchemas } from "@/contracts";
import { resolveEntitlement } from "@/features/purchases/server";
import { getAi } from "@/server/ai";
import { runTool } from "@/tools/registry";
import { createMcpServer, type McpServerOptions } from "@/mcp/server";
import { DEMO_APP_USER_ID } from "@/fixtures";
import { createUser, DEMO_EMAIL, grantCredit, grantPro, loginDemo, seedOnboardedCreator } from "../helpers";

type TextBlock = { type: "text"; text: string };
const CALL_ID = "fixture-beca-artes-plasticas";

let client: Client | undefined;
beforeEach(async () => {
  await loginDemo(); // the MCP server acts as this account (MECENA_USER_EMAIL in real life)
});
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(opts?: McpServerOptions) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ userEmail: DEMO_EMAIL, ...opts });
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await c.callTool({ name, arguments: args });
  return { isError: Boolean(res.isError), blocks: res.content as TextBlock[] };
}

const json = (blocks: TextBlock[]) => JSON.parse(blocks[1].text);

describe("MCP server tools", () => {
  it("lists the MCP tools with descriptions and JSON input schemas, plus server instructions", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    // drafting and the jury run on the client's model: the server-AI versions are not offered over MCP
    expect(tools.map((t) => t.name)).not.toContain("draft_application");
    expect(tools.map((t) => t.name)).not.toContain("score_application");
    for (const t of tools) {
      expect(t.description).toBe(toolSchemas[t.name as keyof typeof toolSchemas].description);
      expect(t.inputSchema.type).toBe("object");
    }
    const save = tools.find((t) => t.name === "save_application_draft")!;
    expect(save.inputSchema.required).toEqual(expect.arrayContaining(["callId", "sections"]));
    expect(c.getInstructions()).toMatch(/Mecena prepara/);
    expect(c.getInstructions()).toMatch(/Tú redactas la solicitud/);
  });

  it("search_calls returns results for the fixture creator: Spanish summary + JSON, links on MECENA_PUBLIC_URL", async () => {
    await seedOnboardedCreator();
    const c = await connect();
    const { isError, blocks } = await call(c, "search_calls");
    expect(isError).toBe(false);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toMatch(/He encontrado \d+ convocatoria/);
    expect(blocks[0].text).toContain("http://localhost:3000/convocatorias/");
    const out = json(blocks);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.every((r: { call: { beneficiaryKinds: string[] } }) => r.call.beneficiaryKinds.includes("creator"))).toBe(true);
  });

  it("build_dossier with a fixture callId returns a call variant and a public link (Pro)", async () => {
    await seedOnboardedCreator();
    await grantPro();
    const c = await connect();
    const { isError, blocks } = await call(c, "build_dossier", { callId: CALL_ID });
    expect(isError).toBe(false);
    const out = json(blocks);
    expect(out.dossier.variant.callId).toBe(CALL_ID);
    expect(out.adapted).toBe(true);
    expect(out.url.startsWith("http://localhost:3000/dossier?")).toBe(true);
    expect(blocks[0].text).toContain("Adaptado a la convocatoria");
    expect(blocks[0].text).toContain(out.url);
  });

  it("links follow MECENA_PUBLIC_URL (e.g. the phone tunnel)", async () => {
    process.env.MECENA_PUBLIC_URL = "https://mecena-demo.example.dev/";
    try {
      await seedOnboardedCreator();
      const c = await connect();
      const { blocks } = await call(c, "export_dossier_pdf", { callId: CALL_ID });
      expect(json(blocks).url.startsWith("https://mecena-demo.example.dev/api/dossier/pdf?")).toBe(true);
      expect(blocks[0].text).toContain("https://mecena-demo.example.dev/api/dossier/pdf?");
    } finally {
      process.env.MECENA_PUBLIC_URL = "http://localhost:3000";
    }
  });

  it("get_application_context without entitlement is an error with the pricing URL; with grantPro() it returns the context", async () => {
    await seedOnboardedCreator();
    const c = await connect();
    const denied = await call(c, "get_application_context", { callId: CALL_ID });
    expect(denied.isError).toBe(true);
    expect(denied.blocks[0].text).toMatch(/^Necesitas Mecena Pro/);
    expect(denied.blocks[0].text).toContain("http://localhost:3000/pro");

    await grantPro(DEMO_APP_USER_ID); // a purchase on the phone is stored for the account's appUserId and unlocks MCP
    const ok = await call(c, "get_application_context", { callId: CALL_ID });
    expect(ok.isError).toBe(false);
    const out = json(ok.blocks);
    expect(out.call.id).toBe(CALL_ID);
    expect(out.instructions).toMatch(/NUNCA inventes datos/);
    expect(out.sectionKeys).toEqual(["memoria", "statement", "cv"]);
    expect(out.transcript.length).toBeGreaterThan(0);
    expect(out.transcript[0]).toEqual({ id: expect.any(String), text: expect.any(String) });
    expect(out.existing).toBeUndefined();
    expect(ok.blocks[0].text).toMatch(/save_application_draft/);
  });

  it("save_application_draft checks and saves the client's draft; a second save is a new version", async () => {
    await seedOnboardedCreator();
    await grantPro();
    const c = await connect();
    const ctx = json((await call(c, "get_application_context", { callId: CALL_ID })).blocks);
    const segId = ctx.transcript[0].id;
    const expense = ctx.call.allowedExpenses[0];
    const max = ctx.call.amountEur.max ?? 3000;

    const tooMuch = await call(c, "save_application_draft", {
      callId: CALL_ID,
      sections: [{ key: "memoria", title: "Memoria del proyecto", body: "Mi proyecto.", sourceSegmentIds: [segId] }],
      budget: [{ concept: "Materiales", amountEur: max + 1000, expenseType: expense }],
    });
    expect(tooMuch.isError).toBe(true);
    expect(tooMuch.blocks[0].text).toMatch(/supera el máximo/);

    const notAllowed = await call(c, "save_application_draft", {
      callId: CALL_ID,
      sections: [{ key: "memoria", title: "Memoria del proyecto", body: "Mi proyecto." }],
      budget: [{ concept: "Un coche", amountEur: 100, expenseType: "Vehículos de lujo" }],
    });
    expect(notAllowed.isError).toBe(true);
    expect(notAllowed.blocks[0].text).toMatch(/no es un gasto admitido/);

    const saved = await call(c, "save_application_draft", {
      callId: CALL_ID,
      sections: [
        { key: "memoria", title: "Memoria del proyecto", body: "Mi proyecto, con mis palabras.", sourceSegmentIds: [segId, "inventado"] },
        { key: "statement", title: "Declaración artística", body: "Lo que me mueve." },
      ],
      budget: [{ concept: "Materiales", amountEur: 500, expenseType: expense }],
    });
    expect(saved.isError, saved.blocks[0].text).toBe(false);
    const first = json(saved.blocks);
    expect(first.created).toBe(true);
    expect(first.application.version).toBe(1);
    expect(first.application.sections[0].sourceSegmentIds).toEqual([segId]); // ids that are not the user's words are dropped
    expect(first.application.checklist.length).toBeGreaterThan(0); // rebuilt from the call's documents
    expect(first.url).toBe(`http://localhost:3000/solicitud/${CALL_ID}`);
    expect(saved.blocks[0].text).toMatch(/Borrador de solicitud guardado/);

    const again = json((await call(c, "save_application_draft", { callId: CALL_ID, sections: [{ key: "memoria", title: "Memoria", body: "Segunda versión." }] })).blocks);
    expect(again.created).toBe(false);
    expect(again.application.id).toBe(first.application.id);
    expect(again.application.version).toBe(2);
    const reread = json((await call(c, "get_application_context", { callId: CALL_ID })).blocks);
    expect(reread.existing.version).toBe(2);
  });

  it("a first save uses one Solicitud premium credit; later saves are free", async () => {
    await seedOnboardedCreator();
    await grantCredit();
    const c = await connect();
    const section = [{ key: "memoria", title: "Memoria", body: "Texto." }];
    expect((await call(c, "save_application_draft", { callId: CALL_ID, sections: section })).isError).toBe(false);
    expect((await resolveEntitlement(DEMO_APP_USER_ID)).premiumCredits).toBe(0);
    expect((await call(c, "save_application_draft", { callId: CALL_ID, sections: section })).isError).toBe(false);
  });

  it("get_jury_brief + save_jury_score: the client's verdicts are scored like the server jury", async () => {
    await seedOnboardedCreator();
    await grantPro();
    const c = await connect();
    const saved = json((await call(c, "save_application_draft", { callId: CALL_ID, sections: [{ key: "memoria", title: "Memoria", body: "Mi proyecto." }] })).blocks);
    const appId = saved.application.id;
    const briefRes = await call(c, "get_jury_brief", { applicationId: appId });
    expect(briefRes.isError).toBe(false);
    const brief = json(briefRes.blocks);
    expect(brief.judges.length).toBe(3);
    expect(brief.criteria.length).toBeGreaterThan(0);
    expect(brief.instructions).toMatch(/comisión de valoración/);
    expect(brief.runsLeft).toBeNull(); // Pro: unlimited
    type Criterion = { id: string; maxPoints: number };
    const verdict = (judgeId: string, share: number) => ({
      judgeId,
      scores: brief.criteria.map((cr: Criterion) => ({ criterionId: cr.id, points: cr.maxPoints * share, comment: "Bien.", fixes: [`Concreta ${cr.id}`] })),
      overall: "Buena base.",
    });

    const stale = await call(c, "save_jury_score", { applicationId: appId, applicationVersion: 99, verdicts: brief.judges.map((j: { id: string }) => verdict(j.id, 0.5)) });
    expect(stale.isError).toBe(true);
    expect(stale.blocks[0].text).toMatch(/get_jury_brief/);

    const partial = await call(c, "save_jury_score", { applicationId: appId, applicationVersion: 1, verdicts: [verdict(brief.judges[0].id, 0.5)] });
    expect(partial.isError).toBe(true);
    expect(partial.blocks[0].text).toMatch(/un veredicto por cada juez/);

    // 0.5, 0.7, 0.9 of every maximum → 70/100 on average; 10x the maximum is clamped
    const verdicts = brief.judges.map((j: { id: string }, i: number) => verdict(j.id, [0.5, 0.7, 0.9][i]));
    const { isError, blocks } = await call(c, "save_jury_score", { applicationId: appId, applicationVersion: 1, verdicts });
    expect(isError, blocks[0].text).toBe(false);
    const { score, url } = json(blocks);
    expect(score.total).toBe(70);
    expect(score.applicationVersion).toBe(1);
    expect(score.criteria[0].byJudge).toHaveLength(3);
    expect(url).toBe(`http://localhost:3000/tribunal/${appId}`);
    expect(blocks[0].text).toContain("70/100");

    const clamped = await call(c, "save_jury_score", { applicationId: appId, applicationVersion: 1, verdicts: brief.judges.map((j: { id: string }) => verdict(j.id, 10)) });
    expect(json(clamped.blocks).score.total).toBe(100);
  });

  it("without Pro, the jury runs an application includes are counted on save and enforced on the brief", async () => {
    await seedOnboardedCreator();
    await grantCredit();
    const c = await connect();
    const appId = json((await call(c, "save_application_draft", { callId: CALL_ID, sections: [{ key: "memoria", title: "Memoria", body: "Texto." }] })).blocks).application.id;
    for (let run = 0; run < JURY_RUNS_PER_APPLICATION; run++) {
      const brief = json((await call(c, "get_jury_brief", { applicationId: appId })).blocks);
      expect(brief.runsLeft).toBe(JURY_RUNS_PER_APPLICATION - run);
      const verdicts = brief.judges.map((j: { id: string }) => ({
        judgeId: j.id,
        scores: brief.criteria.map((cr: { id: string }) => ({ criterionId: cr.id, points: 1, comment: "", fixes: [] })),
        overall: "",
      }));
      expect((await call(c, "save_jury_score", { applicationId: appId, applicationVersion: 1, verdicts })).isError).toBe(false);
    }
    const denied = await call(c, "get_jury_brief", { applicationId: appId });
    expect(denied.isError).toBe(true);
    expect(denied.blocks[0].text).toMatch(/pasadas por el tribunal/);
  });

  it("no MCP tool reaches the Anthropic API, even with a key set", async () => {
    await seedOnboardedCreator();
    await grantPro();
    const prev = { key: process.env.ANTHROPIC_API_KEY, mock: process.env.MECENA_AI_MOCK };
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
    delete process.env.MECENA_AI_MOCK;
    try {
      expect(getAi().mode).toBe("anthropic"); // outside MCP, the key would be used
      const modes: string[] = [];
      const c = await connect({ run: async (name, input, ctx) => (modes.push(getAi().mode), runTool(name, input, ctx)) });
      for (const [name, args] of [
        ["explain_call", { callId: CALL_ID }],
        ["build_dossier", { callId: CALL_ID }],
        ["get_application_context", { callId: CALL_ID }],
      ] as const) {
        const r = await call(c, name, args);
        expect(r.isError, `${name}: ${r.blocks[0]?.text}`).toBe(false);
      }
      expect(modes).toEqual(["mock", "mock", "mock"]);
    } finally {
      if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev.key;
      if (prev.mock !== undefined) process.env.MECENA_AI_MOCK = prev.mock;
    }
  });

  it("every tool runs over MCP on the seeded demo", async () => {
    await seedOnboardedCreator();
    await grantPro();
    const c = await connect();
    const args: Record<string, Record<string, unknown>> = {
      get_profile: {},
      update_profile: { patch: { city: "Lugo" } },
      build_dossier: {},
      export_dossier_pdf: {},
      search_calls: { query: "beca", limit: 2 },
      explain_call: { callId: CALL_ID },
      get_application_context: { callId: CALL_ID },
      save_application_draft: { callId: CALL_ID, sections: [{ key: "memoria", title: "Memoria", body: "Mi proyecto." }] },
    };
    for (const [name, a] of Object.entries(args)) {
      const r = await call(c, name, a);
      expect(r.isError, `${name}: ${r.blocks[0]?.text}`).toBe(false);
      expect(r.blocks[0].text.length).toBeGreaterThan(0);
    }
    expect(json((await call(c, "get_profile")).blocks).profile.city).toBe("Lugo");
  });

  it("unknown ids come back as a Spanish isError message, not a crash", async () => {
    const c = await connect();
    const r = await call(c, "explain_call", { callId: "no-existe" });
    expect(r.isError).toBe(true);
    expect(r.blocks[0].text).toMatch(/no encontr/i);
  });

  it("uses the injected runner (handlers implemented in parallel WPs can be faked)", async () => {
    const seen: string[] = [];
    const c = await connect({
      run: async (name, input, ctx) => {
        seen.push(`${name}:${ctx.caller}:${JSON.stringify(input)}`);
        return { score: { total: 84, criteria: [], disclaimer: "Orientativo." }, url: "http://localhost:3000/tribunal/x" };
      },
    });
    const verdicts = [{ judgeId: "j", scores: [], overall: "" }];
    const r = await call(c, "save_jury_score", { applicationId: "x", applicationVersion: 1, verdicts });
    expect(r.blocks[0].text).toContain("84/100");
    expect(seen).toEqual([`save_jury_score:mcp:${JSON.stringify({ applicationId: "x", applicationVersion: 1, verdicts })}`]);
  });

  it("only ever sees its own account: another user's profile id is 'not found'", async () => {
    const other = await createUser("otra@mecena.test");
    const c = await connect();
    const r = await call(c, "get_profile", { profileId: other.user.activeProfileId });
    expect(r.isError).toBe(true);
    expect(r.blocks[0].text).toMatch(/no encontr/i);
    const mine = await call(c, "get_profile");
    expect(json(mine.blocks).profile.id).toBe("demo-creator");
  });

  it("without a configured account every tool call is an error that explains MECENA_USER_EMAIL", async () => {
    const c = await connect({ userEmail: "" });
    const r = await call(c, "get_profile");
    expect(r.isError).toBe(true);
    expect(r.blocks[0].text).toContain("MECENA_USER_EMAIL");
    const unknown = await connect({ userEmail: "nadie@mecena.test" });
    expect((await call(unknown, "get_profile")).blocks[0].text).toMatch(/No hay ninguna cuenta/);
  });
});
