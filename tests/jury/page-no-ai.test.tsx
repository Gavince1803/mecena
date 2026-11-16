// @vitest-environment jsdom
/** The jury page without AI on the server (ADR-027): no scoring request, the user's own assistant instead. */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postApp } from "@/app/api/applications/route";
import { GET as getAssistant } from "@/app/api/applications/[id]/assistant/route";
import { GET as getJury, POST as postJury } from "@/app/api/jury/route";
import { DEMO_APP_USER_ID, DEMO_CREATOR_ID } from "@/fixtures";
import { JuryPage } from "@/features/jury/ui/JuryPage";
import { saveClientScore, clientJuryBrief } from "@/features/jury/service";
import { ctx, grantPro, loginDemo, req, seedOnboardedCreator } from "../helpers";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

const posted: string[] = [];

beforeEach(async () => {
  process.env.MECENA_NO_AI = "1";
  await loginDemo();
  posted.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0];
    const method = (init?.method ?? "GET") as "GET" | "POST";
    if (method === "POST") posted.push(path);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const r = req(url, { method, body });
    if (path === "/api/jury") return method === "GET" ? getJury(r) : postJury(r);
    const m = /^\/api\/applications\/([^/]+)\/assistant$/.exec(path);
    if (m) return getAssistant(r, ctx({ id: decodeURIComponent(m[1]) }));
    throw new Error(`no route ${method} ${path}`);
  });
});
afterEach(() => {
  delete process.env.MECENA_NO_AI;
  vi.unstubAllGlobals();
});

async function draft() {
  await seedOnboardedCreator();
  await grantPro();
  const res = await postApp(req("/api/applications", { body: { callId: "fixture-beca-artes-plasticas", profileId: DEMO_CREATOR_ID, appUserId: DEMO_APP_USER_ID } }));
  return (await res.json()).application;
}

describe("JuryPage without AI on the server", () => {
  it("never asks the server to score: it offers the text for the user's assistant", async () => {
    const app = await draft();
    render(<JuryPage applicationId={app.id} />);
    expect(await screen.findByText("Pásalo con tu asistente")).toBeTruthy();
    await waitFor(() => expect((screen.getByText("Copiar para tu asistente") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(/Conectar Claude u otro asistente/)).toBeTruthy();
    expect(posted).toEqual([]);
  });

  it("shows a score saved by the user's assistant over MCP, without 'Aplicar mejoras'", async () => {
    const app = await draft();
    const brief = await clientJuryBrief(app.id, { appUserId: DEMO_APP_USER_ID });
    const verdicts = brief.judges.map((j) => ({
      judgeId: j.id,
      scores: brief.criteria.map((c) => ({ criterionId: c.id, points: c.maxPoints * 0.7, comment: "Bien.", fixes: [`Concreta ${c.name}`] })),
      overall: "Buena base.",
    }));
    await saveClientScore({ applicationId: app.id, applicationVersion: app.version, verdicts }, { appUserId: DEMO_APP_USER_ID });
    render(<JuryPage applicationId={app.id} />);
    expect(await screen.findByText("Criterios de valoración de las bases")).toBeTruthy();
    expect(screen.getByText("Mejoras que proponen")).toBeTruthy();
    expect(screen.queryByText("Aplicar mejoras")).toBeNull();
    expect(screen.getByText("Pásalo con tu asistente")).toBeTruthy();
    expect(posted).toEqual([]);
  });
});
