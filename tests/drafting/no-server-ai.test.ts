/** ADR-027: the app without AI on the server, and the user's own assistant (copy the prompt, paste the answer back). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getApps, POST as postApp } from "@/app/api/applications/route";
import { GET as getAssistant } from "@/app/api/applications/[id]/assistant/route";
import { GET as getJury, POST as postJury } from "@/app/api/jury/route";
import { POST as postResearch } from "@/app/api/calls/research/route";
import { JURY_RUNS_PER_APPLICATION, serverEnv, type ApplicationSection } from "@/contracts";
import { runWithAiSwitches } from "@/features/demo/ai-mode";
import { fillGap, listGaps, parseAssistantReply } from "@/features/drafting/reply";
import { juryRunsLeft, resolveEntitlement } from "@/features/purchases/server";
import { getAi } from "@/server/ai";
import { AiUnavailableError } from "@/server/ai/llm";
import { DEMO_APP_USER_ID, DEMO_CREATOR_ID } from "@/fixtures";
import { createUser, ctx, grantCredit, grantPro, loginDemo, req, seedOnboardedCreator, useSession } from "../helpers";

const CALL = "fixture-beca-artes-plasticas";
const invoiceInput = { imageBase64: "AAAA", mediaType: "image/jpeg" as const, budget: [], allowedExpenses: [] };

async function draftOne() {
  await loginDemo();
  await seedOnboardedCreator();
  const res = await postApp(req("/api/applications", { body: { callId: CALL, profileId: DEMO_CREATOR_ID, appUserId: DEMO_APP_USER_ID } }));
  expect(res.status).toBe(201);
  return (await res.json()).application as { id: string; version: number; sections: ApplicationSection[] };
}

describe("no AI on the server", () => {
  beforeEach(() => {
    process.env.MECENA_NO_AI = "1";
  });
  afterEach(() => {
    delete process.env.MECENA_NO_AI;
    vi.unstubAllEnvs();
  });

  it("is on by default in production without a key, and off with a key or outside production", () => {
    delete process.env.MECENA_NO_AI;
    vi.stubEnv("NODE_ENV", "production");
    expect(serverEnv().noAi).toBe(true);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(serverEnv().noAi).toBe(false);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(serverEnv().noAi).toBe(false);
  });

  it("swaps the mocks built for tests and the demo for honest versions", async () => {
    const ai = getAi();
    expect(await ai.extractInvoice(invoiceInput)).toMatchObject({ supplier: "", concept: "", totalEur: 0, fallback: true });
    const work = await ai.describeWork({ kind: "creator", imageBase64: "AAAA", mediaType: "image/jpeg", voiceDescription: "Óleo sobre lino, 2024" });
    expect(work.fallback).toBe(true);
    await expect(ai.judgeApplication({} as never)).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(ai.reviseApplication({} as never)).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(ai.deepResearch({} as never)).rejects.toBeInstanceOf(AiUnavailableError);
    // an account with the demo switch "IA simulada" on still gets the demo mocks (explicit choice for a stage account)
    const demo = await runWithAiSwitches({ aiMock: true }, () => getAi().extractInvoice(invoiceInput));
    expect(demo.fallback).toBeFalsy();
  });

  it("drafts the rule-based version; the jury answers 503 in Spanish and gives the run back", async () => {
    await grantCredit();
    const app = await draftOne();
    expect(app.sections.length).toBeGreaterThan(0);
    const page = await (await getApps(req(`/api/applications?callId=${CALL}&profileId=${DEMO_CREATOR_ID}`))).json();
    expect(page.serverAi).toBe(false);
    expect((await (await getJury(req(`/api/jury?applicationId=${app.id}`))).json()).serverAi).toBe(false);

    const res = await postJury(req("/api/jury", { body: { applicationId: app.id } }));
    expect(res.status).toBe(503);
    expect((await res.json()).message).toMatch(/tribunal simulado necesita IA/);
    expect(juryRunsLeft(await resolveEntitlement(DEMO_APP_USER_ID), app.id)).toBe(JURY_RUNS_PER_APPLICATION);
  });

  it("refuses deep research before the paywall, so nobody pays for it", async () => {
    await loginDemo();
    await seedOnboardedCreator();
    const res = await postResearch(req("/api/calls/research", { body: { profileId: DEMO_CREATOR_ID } }));
    expect(res.status).toBe(503);
    expect((await res.json()).message).toMatch(/búsqueda ampliada necesita IA/);
  });

  it("with AI on the server (here, the tests' mocks) the pages are told so", async () => {
    delete process.env.MECENA_NO_AI;
    await grantPro();
    const app = await draftOne();
    expect((await (await getApps(req(`/api/applications?callId=${CALL}&profileId=${DEMO_CREATOR_ID}`))).json()).serverAi).toBe(true);
    expect((await (await getJury(req(`/api/jury?applicationId=${app.id}`))).json()).serverAi).toBe(true);
  });
});

describe("copy for your assistant", () => {
  it("the draft prompt carries the rules, the call, the user's words and the draft with its titles", async () => {
    await grantPro();
    const app = await draftOne();
    const res = await getAssistant(req(`/api/applications/${app.id}/assistant?task=draft`), ctx({ id: app.id }));
    expect(res.status).toBe(200);
    const { text } = await res.json();
    expect(text).toMatch(/NUNCA inventes datos/);
    expect(text).toContain("=== LA CONVOCATORIA ===");
    expect(text).toContain("Criterios de valoración:");
    expect(text).toContain("=== MIS PALABRAS (de la entrevista) ===");
    for (const s of app.sections) expect(text).toContain(`## ${s.title}`);
    expect(text).not.toContain(DEMO_APP_USER_ID); // no ids or account data beyond the profile's own facts
  });

  it("the jury prompt names the judges and asks for a total over 100", async () => {
    await grantPro();
    const app = await draftOne();
    const { text } = await (await getAssistant(req(`/api/applications/${app.id}/assistant?task=jury`), ctx({ id: app.id }))).json();
    expect(text).toMatch(/comisión de valoración/);
    expect(text).toMatch(/Sois 3 jueces/);
    expect(text).toMatch(/total sobre 100/);
  });

  it("only for the owner's applications", async () => {
    await grantPro();
    const app = await draftOne();
    const other = await createUser("otra@mecena.test");
    useSession(other.cookie);
    expect((await getAssistant(req(`/api/applications/${app.id}/assistant?task=draft`), ctx({ id: app.id }))).status).toBe(404);
  });
});

describe("pasting the assistant's answer back and filling gaps", () => {
  const sections: ApplicationSection[] = [
    { key: "memoria", title: "Memoria del proyecto", body: "Antes. [Completa: fechas de inicio y fin]", sourceSegmentIds: ["s1"] },
    { key: "statement", title: "Declaración artística", body: "Mi voz.", sourceSegmentIds: [] },
  ];

  it("matches '## Título' blocks to the draft's sections, tolerating markdown and accents", () => {
    const reply = "Aquí tienes:\n\n## **Memoria del proyecto**\nNueva memoria con **fechas**.\n\n### 2. Declaracion artistica:\nNueva declaración.\n\n## Presupuesto\n- 500 €";
    const r = parseAssistantReply(reply, sections);
    if ("error" in r) throw new Error(r.error);
    expect(r.sections[0]).toMatchObject({ key: "memoria", body: "Nueva memoria con fechas.", sourceSegmentIds: ["s1"] });
    expect(r.sections[1].body).toBe("Nueva declaración.");
    expect(r.matched).toEqual(["Memoria del proyecto", "Declaración artística"]);
    expect(r.unmatched).toEqual(["Presupuesto"]); // never a new section
  });

  it("keeps the sections the answer does not mention, and falls back to order when no title matches", () => {
    const one = parseAssistantReply("## Memoria del proyecto\nSolo esta.", sections);
    if ("error" in one) throw new Error(one.error);
    expect(one.sections[1].body).toBe("Mi voz.");
    const byOrder = parseAssistantReply("## Uno\nA.\n\n## Dos\nB.", sections);
    if ("error" in byOrder) throw new Error(byOrder.error);
    expect(byOrder.sections.map((s) => s.body)).toEqual(["A.", "B."]);
  });

  it("explains what is wrong when there are no usable headings", () => {
    expect(parseAssistantReply("Un texto sin apartados.", sections)).toMatchObject({ error: expect.stringMatching(/## Título/) });
    expect(parseAssistantReply("## Otra cosa\nTexto.", sections)).toMatchObject({ error: expect.stringMatching(/no coinciden/) });
  });

  it("lists the gaps and fills one with the user's words, as written", () => {
    const gaps = listGaps(sections);
    expect(gaps).toEqual([{ section: 0, text: "[Completa: fechas de inicio y fin]", label: "fechas de inicio y fin" }]);
    expect(fillGap(sections, gaps[0], " De marzo a junio de 2027 ")[0].body).toBe("Antes. De marzo a junio de 2027");
    expect(fillGap(sections, gaps[0], "   ")[0].body).toBe(sections[0].body);
  });
});
