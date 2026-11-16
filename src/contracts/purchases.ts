/**
 * Monetisation contract (RevenueCat Web Billing, sandbox for the demo).
 * Client side: a PurchasesAdapter (real = @revenuecat/purchases-js, mock = in-memory + /api/entitlements).
 * Server side: EntitlementState in the store. Free: the rule-based draft of a call the free plan shows. Pro: everything.
 * Solicitud premium: one credit unlocks one call (everything Pro gives, for that call: see unlockCall).
 */
import type { EntitlementState } from "./domain";

/** The Pro entitlement identifier in our RevenueCat dashboard (NEXT_PUBLIC_REVENUECAT_ENTITLEMENT_ID overrides it). */
export const ENTITLEMENT_PRO = "mecena_pro";

/** Product identifiers to create in RevenueCat (Web Billing products) and attach to the default offering. */
export const PRODUCTS = {
  proMonthly: "mecena_pro_monthly", // 3.99 EUR / month, grants the Pro entitlement
  proAnnual: "mecena_pro_annual", // 35.88 EUR / year (2.99 EUR / month), grants the Pro entitlement
  solicitudPremium: "mecena_solicitud_premium", // 15 EUR one-off (consumable): +1 premium credit
} as const;

/** Package identifiers inside the RevenueCat offering. */
export const PACKAGES = {
  proMonthly: "$rc_monthly",
  proAnnual: "$rc_annual",
  solicitudPremium: "solicitud_premium",
} as const;

export type PlanId = keyof typeof PRODUCTS;

export interface Plan {
  id: PlanId;
  title: string; // "Pro mensual"
  priceText: string; // "3,99 €/mes" (from RevenueCat formattedPrice when live)
  kind: "subscription" | "one_off";
  period?: "P1M" | "P1Y";
  highlight?: boolean; // annual = best value
  bullets: string[];
}

export type PurchaseOutcome =
  | { status: "purchased"; entitlement: EntitlementState }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface PurchasesAdapter {
  readonly mode: "revenuecat" | "mock";
  init(appUserId: string): Promise<void>;
  getPlans(): Promise<Plan[]>;
  purchase(planId: PlanId, opts?: { htmlTarget?: HTMLElement; email?: string }): Promise<PurchaseOutcome>;
  getEntitlement(): Promise<EntitlementState>;
  /** "Restaurar compras": the server re-reads the customer from RevenueCat and returns the fresh entitlement. */
  restore(): Promise<EntitlementState>;
}

/** Where the paywall was triggered from, for copy and analytics. */
export type PaywallTrigger = "draft_application" | "match_limit" | "jury" | "dossier_variant" | "pricing_page";

export const FREE_MATCHES_PER_MONTH = 3;

/** Simulated-jury runs included for an application of a call unlocked with a Solicitud premium (Pro: unlimited). */
export const JURY_RUNS_PER_APPLICATION = 5;

/** On the free plan, jury runs per application that cost Mecena no AI (run by the user's own assistant over MCP). */
export const FREE_JURY_RUNS_PER_APPLICATION = 1;

/** Pro, or this call was unlocked with a Solicitud premium credit. */
export function hasCallAccess(e: Pick<EntitlementState, "pro" | "unlockedCalls"> | undefined, callId: string): boolean {
  return !!e && (e.pro || (e.unlockedCalls ?? []).includes(callId));
}
