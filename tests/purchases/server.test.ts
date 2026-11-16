import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_JURY_RUNS_PER_APPLICATION, JURY_RUNS_PER_APPLICATION, PaymentRequiredError } from "@/contracts";
import { GET, POST } from "@/app/api/entitlements/route";
import { draftingAi } from "@/features/drafting/ai";
import { draftApplication } from "@/features/drafting/service";
import { resolveEntitlement, syncEntitlement, unlockCall, verificationMode, withJuryRun } from "@/features/purchases/server";
import { canSeeCall, unlockCalls } from "@/features/matching/usage";
import { POST as postUnlock } from "@/app/api/entitlements/unlock/route";
import { GET as getDossier } from "@/app/api/dossier/route";
import { DEMO_APP_USER_ID, DEMO_CREATOR_ID } from "@/fixtures";
import { getEntitlement, nowIso, readDb, saveApplication, saveEntitlement } from "@/server/store";
import { createUser, grantPro, loginDemo, req, seedOnboardedCreator } from "../helpers";

// Route handlers need a session: run as the demo account (owns the fixture profiles).
beforeEach(async () => {
  await loginDemo();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const buyPremium = (appUserId: string) => syncEntitlement({ appUserId, purchasedProductId: "mecena_solicitud_premium" });

describe("verification mode", () => {
  it("tests run in the explicit mock mode", () => {
    expect(verificationMode()).toBe("mock");
  });

  it("production or a non-mock build without the secret key is disabled; the secret key always means RevenueCat", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(verificationMode()).toBe("disabled");
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_PURCHASES_MOCK", "0");
    expect(verificationMode()).toBe("disabled");
    vi.stubEnv("REVENUECAT_SECRET_API_KEY", "sk_test_x");
    expect(verificationMode()).toBe("revenuecat");
  });
});

describe("Solicitud premium: one credit unlocks one call", () => {
  it("no credit → PaymentRequiredError", async () => {
    await expect(unlockCall("nobody", "call-a")).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it("a credit unlocks exactly one call; the same call again spends nothing; another call needs another credit", async () => {
    await buyPremium("u1");
    expect((await unlockCall("u1", "call-a")).unlockedCalls).toEqual(["call-a"]);
    expect(getEntitlement("u1")).toMatchObject({ premiumCredits: 0, premiumUsed: 1 });
    await expect(unlockCall("u1", "call-a")).resolves.toMatchObject({ premiumCredits: 0 });
    await expect(unlockCall("u1", "call-b")).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(getEntitlement("u1").premiumUsed).toBe(1);
  });

  it("two concurrent unlocks never share one credit", async () => {
    await buyPremium("u-race");
    const out = await Promise.allSettled([unlockCall("u-race", "a"), unlockCall("u-race", "b"), unlockCall("u-race", "c")]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(out.filter((o) => o.status === "rejected" && o.reason instanceof PaymentRequiredError)).toHaveLength(2);
    expect(getEntitlement("u-race").premiumCredits).toBe(0);
  });

  it("Pro unlocks every call and never spends credits", async () => {
    await syncEntitlement({ appUserId: "u2", purchasedProductId: "mecena_pro_monthly" });
    await buyPremium("u2");
    for (const c of ["a", "b", "c"]) await unlockCall("u2", c);
    expect(getEntitlement("u2").premiumCredits).toBe(1);
  });

  it("an expired Pro is not Pro (and unlocks nothing without a credit)", async () => {
    await saveEntitlement({ appUserId: "u-exp", pro: true, premiumCredits: 0, expiresAt: new Date(Date.now() - 60_000).toISOString(), source: "mock", updatedAt: nowIso() });
    expect((await resolveEntitlement("u-exp")).pro).toBe(false);
    await expect(unlockCall("u-exp", "a")).rejects.toBeInstanceOf(PaymentRequiredError);
    await saveEntitlement({ appUserId: "u-live", pro: true, premiumCredits: 0, expiresAt: new Date(Date.now() + 864e5).toISOString(), source: "mock", updatedAt: nowIso() });
    expect((await resolveEntitlement("u-live")).pro).toBe(true);
  });
});

describe("draftApplication", () => {
  const CALL = "fixture-beca-artes-plasticas";
  const ctx = { appUserId: DEMO_APP_USER_ID };
  /** Spend the month's free matches on other calls, so CALL is beyond the free plan. */
  const fillFreeQuota = () => unlockCalls({ appUserId: DEMO_APP_USER_ID, profileId: DEMO_CREATOR_ID }, ["other-1", "other-2", "other-3"]);

  it("the free plan drafts the rule-based version of a call it shows, marked free, without any AI or credit", async () => {
    await seedOnboardedCreator();
    const spy = vi.spyOn(draftingAi.mock, "draftApplication");
    const app = await draftApplication({ callId: CALL, profileId: DEMO_CREATOR_ID }, ctx);
    expect(app.plan).toBe("free");
    expect(app.sections.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled(); // the rule-based draft, never the model slice
  });

  it("a double tap drafts once", async () => {
    await seedOnboardedCreator();
    const input = { callId: CALL, profileId: DEMO_CREATOR_ID };
    const [a, b] = await Promise.all([draftApplication(input, ctx), draftApplication(input, ctx)]);
    expect(a.id).toBe(b.id);
    expect(readDb().applications.filter((x) => x.profileId === DEMO_CREATOR_ID && x.callId === CALL)).toHaveLength(1);
  });

  it("a call beyond the month's free matches: 402 until it is unlocked with a credit, then the paid draft", async () => {
    await seedOnboardedCreator();
    await fillFreeQuota();
    await expect(draftApplication({ callId: CALL, profileId: DEMO_CREATOR_ID }, ctx)).rejects.toBeInstanceOf(PaymentRequiredError);
    await buyPremium(DEMO_APP_USER_ID);
    await unlockCall(DEMO_APP_USER_ID, CALL);
    const spy = vi.spyOn(draftingAi.mock, "draftApplication");
    const app = await draftApplication({ callId: CALL, profileId: DEMO_CREATOR_ID }, ctx);
    expect(app.plan).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("Pro drafts any call with the model", async () => {
    await seedOnboardedCreator();
    await fillFreeQuota();
    await grantPro();
    const app = await draftApplication({ callId: CALL, profileId: DEMO_CREATOR_ID }, ctx);
    expect(app.plan).toBeUndefined();
  });
});

describe("simulated jury entitlement", () => {
  let n = 0;
  async function application(plan?: "free", callId = "fixture-beca-artes-plasticas") {
    const now = nowIso();
    return saveApplication({ id: `app-${++n}`, profileId: DEMO_CREATOR_ID, callId, version: 1, status: "draft", sections: [], budget: [], checklist: [], ...(plan ? { plan } : {}), createdAt: now, updatedAt: now });
  }
  const ok = async () => "ok";

  it(`a paid application (or one from before free drafts) includes ${JURY_RUNS_PER_APPLICATION} runs, then 402; another has its own`, async () => {
    const [a, b] = [await application(), await application()];
    for (let i = 0; i < JURY_RUNS_PER_APPLICATION; i++) await withJuryRun("j1", a.id, ok);
    await expect(withJuryRun("j1", a.id, ok)).rejects.toBeInstanceOf(PaymentRequiredError);
    await expect(withJuryRun("j1", b.id, ok)).resolves.toBe("ok");
  });

  it(`a free application: no run on Mecena's AI, ${FREE_JURY_RUNS_PER_APPLICATION} with the user's own assistant; a Solicitud premium for the call gives ${JURY_RUNS_PER_APPLICATION}`, async () => {
    const a = await application("free");
    await expect(withJuryRun("j4", a.id, ok, { costsAi: true })).rejects.toThrow(/MCP/);
    for (let i = 0; i < FREE_JURY_RUNS_PER_APPLICATION; i++) await withJuryRun("j4", a.id, ok, { costsAi: false });
    await expect(withJuryRun("j4", a.id, ok, { costsAi: false })).rejects.toBeInstanceOf(PaymentRequiredError);
    await buyPremium("j4");
    await unlockCall("j4", a.callId);
    await expect(withJuryRun("j4", a.id, ok, { costsAi: true })).resolves.toBe("ok");
  });

  it("a failed run is not counted", async () => {
    const a = await application();
    await expect(withJuryRun("j2", a.id, async () => Promise.reject(new Error("AI down")))).rejects.toThrow("AI down");
    expect(getEntitlement("j2").juryRuns?.[a.id]).toBe(0);
  });

  it("Pro is unlimited", async () => {
    await grantPro("j3");
    const a = await application("free");
    for (let i = 0; i < JURY_RUNS_PER_APPLICATION + 2; i++) await withJuryRun("j3", a.id, ok);
    expect(getEntitlement("j3").juryRuns).toBeUndefined();
  });
});

describe("a call unlocked with a Solicitud premium", () => {
  const CALL = "fixture-beca-artes-plasticas";
  const OTHER = "fixture-premio-ilustracion";

  it("POST /api/entitlements/unlock: 404 for an unknown call and 402 without a credit, both spending nothing", async () => {
    expect((await postUnlock(req("/api/entitlements/unlock", { body: { callId: "no-existe" } }))).status).toBe(404);
    const denied = await postUnlock(req("/api/entitlements/unlock", { body: { callId: CALL } }));
    expect(denied.status).toBe(402);
    expect((await denied.json()).message).toMatch(/Mecena Pro o una Solicitud premium/);
  });

  it("gives that call (only) what Pro gives: in full beyond the free matches and its adapted dossier", async () => {
    await seedOnboardedCreator();
    await unlockCalls({ appUserId: DEMO_APP_USER_ID, profileId: DEMO_CREATOR_ID }, ["other-1", "other-2", "other-3"]);
    await buyPremium(DEMO_APP_USER_ID);
    const res = await postUnlock(req("/api/entitlements/unlock", { body: { callId: CALL } }));
    expect(res.status).toBe(200);
    expect((await res.json()).entitlement).toMatchObject({ premiumCredits: 0, unlockedCalls: [CALL] });

    expect(await canSeeCall({ appUserId: DEMO_APP_USER_ID, profileId: DEMO_CREATOR_ID, callId: CALL })).toBe(true);
    expect(await canSeeCall({ appUserId: DEMO_APP_USER_ID, profileId: DEMO_CREATOR_ID, callId: OTHER })).toBe(false);
    const dossier = async (callId: string) => (await getDossier(req(`/api/dossier?profileId=${DEMO_CREATOR_ID}&callId=${callId}`))).json();
    expect((await dossier(CALL)).adapted).toBe(true);
    expect((await dossier(OTHER)).adapted).toBe(false);
  });
});

describe("/api/entitlements", () => {
  it("POST grants (mock) to the signed-in user and GET reads it back", async () => {
    const posted = await (await POST(req("/api/entitlements", { body: { purchasedProductId: "mecena_pro_annual", via: "mock" } }))).json();
    expect(posted.entitlement).toMatchObject({ appUserId: DEMO_APP_USER_ID, pro: true, activeProductId: "mecena_pro_annual", source: "mock" });
    const got = await (await GET(req("/api/entitlements"))).json();
    expect(got.entitlement.pro).toBe(true);
  });

  it("never grants from a pro / premiumCredits claim, even in mock mode", async () => {
    const res = await POST(req("/api/entitlements", { body: { pro: true, premiumCredits: 999, via: "revenuecat" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).entitlement).toMatchObject({ pro: false, premiumCredits: 0 });
    expect(getEntitlement(DEMO_APP_USER_ID)).toMatchObject({ pro: false, premiumCredits: 0 });
  });

  it("rejects an unknown product id (400)", async () => {
    expect((await POST(req("/api/entitlements", { body: { purchasedProductId: "free_money" } }))).status).toBe(400);
  });

  it("production without the secret key: refuses any purchase claim (503, logged) and grants nothing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const body of [{ purchasedProductId: "mecena_pro_annual" }, { purchasedProductId: "mecena_solicitud_premium", pro: true, premiumCredits: 999 }]) {
      const res = await POST(req("/api/entitlements", { body }));
      expect(res.status).toBe(503);
      expect((await res.json()).message).toMatch(/Restaurar compras/);
    }
    expect(log.mock.calls.some((c) => String(c[0]).includes("REVENUECAT_SECRET_API_KEY is not set"))).toBe(true);
    expect((await POST(req("/api/entitlements", { body: { pro: true, premiumCredits: 999 } }))).status).toBe(200);
    expect(getEntitlement(DEMO_APP_USER_ID)).toMatchObject({ pro: false, premiumCredits: 0 });
  });

  it("production without the secret key: 'Restaurar compras' answers 503 instead of 'no purchases'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await POST(req("/api/entitlements", { body: { refresh: true } }))).status).toBe(503);
    expect((await GET(req("/api/entitlements?refresh=1"))).status).toBe(503);
    expect((await GET(req("/api/entitlements"))).status).toBe(200);
  });

  it("a non-mock build without the secret key refuses too", async () => {
    vi.stubEnv("NEXT_PUBLIC_PURCHASES_MOCK", "0");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await POST(req("/api/entitlements", { body: { purchasedProductId: "mecena_pro_monthly" } }))).status).toBe(503);
    expect(getEntitlement(DEMO_APP_USER_ID).pro).toBe(false);
  });

  it("refresh without the secret key returns the stored state", async () => {
    await grantPro(DEMO_APP_USER_ID);
    const res = await POST(req("/api/entitlements", { body: { refresh: true } }));
    expect((await res.json()).entitlement.pro).toBe(true);
    expect((await (await GET(req("/api/entitlements?refresh=1"))).json()).entitlement.pro).toBe(true);
  });

  it("ignores a client-supplied appUserId: the purchase lands on the user's own id, and nobody reads someone else's", async () => {
    const posted = await (await POST(req("/api/entitlements", { body: { appUserId: "u3", purchasedProductId: "mecena_pro_annual" } }))).json();
    expect(posted.entitlement.appUserId).toBe(DEMO_APP_USER_ID);
    expect(getEntitlement("u3").pro).toBe(false);
    await syncEntitlement({ appUserId: "u4", purchasedProductId: "mecena_pro_monthly" });
    const { cookie } = await createUser("sin-pro@mecena.test");
    const got = await (await GET(req("/api/entitlements?appUserId=u4", { cookie }))).json();
    expect(got.entitlement.pro).toBe(false);
  });

  it("401 without a session", async () => {
    expect((await GET(req("/api/entitlements", { cookie: null }))).status).toBe(401);
    expect((await POST(req("/api/entitlements", { body: { refresh: true }, cookie: null }))).status).toBe(401);
  });
});
