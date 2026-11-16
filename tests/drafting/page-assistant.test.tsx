// @vitest-environment jsdom
/** The draft page without AI on the server: fill a "[Completa: …]" gap, paste the user's assistant's answer back. */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getApps, POST as postApp } from "@/app/api/applications/route";
import { GET as getApp, PATCH as patchApp } from "@/app/api/applications/[id]/route";
import { GET as getAssistant } from "@/app/api/applications/[id]/assistant/route";
import { GET as getCallRoute } from "@/app/api/calls/[id]/route";
import { DEMO_APP_USER_ID, DEMO_CREATOR_ID } from "@/fixtures";
import { DraftPage } from "@/features/drafting/ui/DraftPage";
import { getApplication } from "@/server/store";
import { ctx, grantPro, loginDemo, req, seedOnboardedCreator } from "../helpers";

const CALL = "fixture-beca-artes-plasticas";
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
let profile: unknown;
vi.mock("@/components/shell/AppProvider", () => ({ useApp: () => ({ profile, appUserId: DEMO_APP_USER_ID }) }));

const posted: string[] = [];
beforeEach(async () => {
  process.env.MECENA_NO_AI = "1";
  await loginDemo();
  posted.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0];
    const method = (init?.method ?? "GET") as "GET" | "POST" | "PATCH";
    if (method !== "GET") posted.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const r = req(url, { method, body });
    if (path === "/api/applications") return getApps(r);
    let m = /^\/api\/applications\/([^/]+)\/assistant$/.exec(path);
    if (m) return getAssistant(r, ctx({ id: decodeURIComponent(m[1]) }));
    m = /^\/api\/applications\/([^/]+)$/.exec(path);
    if (m) return method === "PATCH" ? patchApp(r, ctx({ id: decodeURIComponent(m[1]) })) : getApp(r, ctx({ id: decodeURIComponent(m[1]) }));
    m = /^\/api\/calls\/([^/]+)$/.exec(path);
    if (m) return getCallRoute(r, ctx({ id: decodeURIComponent(m[1]) }));
    throw new Error(`no route ${method} ${path}`);
  });
});
afterEach(() => {
  delete process.env.MECENA_NO_AI;
  vi.unstubAllGlobals();
});

describe("DraftPage without AI on the server", () => {
  it("fills a gap with the user's words and pastes back the assistant's answer; never prewarms the jury", async () => {
    profile = await seedOnboardedCreator();
    await grantPro();
    const { application } = await (await postApp(req("/api/applications", { body: { callId: CALL, profileId: DEMO_CREATOR_ID, appUserId: DEMO_APP_USER_ID } }))).json();
    render(<DraftPage callId={CALL} />);

    expect(await screen.findByText("Mejóralo con tu asistente")).toBeTruthy();
    const gapsTitle = await screen.findByText(/^Completa los huecos/);
    expect(gapsTitle).toBeTruthy();
    const input = screen.getAllByRole("textbox").find((el) => el.id === "gap-0")!;
    fireEvent.change(input, { target: { value: "De marzo a junio de 2027" } });
    await act(async () => {
      fireEvent.click(screen.getAllByText("Rellenar")[0]);
    });
    await waitFor(() => expect(getApplication(application.id).sections.some((s) => s.body.includes("De marzo a junio de 2027"))).toBe(true));

    const title = getApplication(application.id).sections[0].title;
    fireEvent.change(screen.getByLabelText("Respuesta de tu asistente"), { target: { value: `## ${title}\nTexto mejorado por mi asistente.` } });
    fireEvent.click(screen.getByText("Revisar"));
    expect(await screen.findByText(/Se cambiarán:/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Guardar en la solicitud"));
    });
    await waitFor(() => expect(getApplication(application.id).sections[0].body).toBe("Texto mejorado por mi asistente."));
    expect(posted.every((p) => p.startsWith("PATCH /api/applications/"))).toBe(true); // no jury prewarm, no AI call
  });
});
