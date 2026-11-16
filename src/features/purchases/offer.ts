// Owned by WP-07. The offer (Hormozi style): sell the outcome, stack the value, anchor, guarantee. Spanish from Spain.
import { FREE_MATCHES_PER_MONTH, hasCallAccess, JURY_RUNS_PER_APPLICATION, type EntitlementState, type PaywallTrigger, type Plan, type PlanId } from "@/contracts";

/**
 * What the free plan includes in the feed, in one place so the paywall, /pro and the feed say the same thing.
 * Keep it in line with the matching limit (src/features/matching/service.ts).
 */
export const FREE_MATCHES_TEXT = `${FREE_MATCHES_PER_MONTH} convocatorias al mes`;

export const OFFER = {
  kicker: "Mecena Pro",
  headline: "Presenta más solicitudes, mejor preparadas.",
  // What Pro sells costs Mecena no AI of its own (ADR-028): it stays true whether or not the server has a model.
  stack: [
    "Todas las convocatorias que encajan contigo, sin límite, y un aviso en la app de las que cierran en los próximos 7 días",
    "Tu dossier adaptado a cada convocatoria: orden, límite de imágenes y textos según sus criterios, en PDF y con las fotos listas",
    "Tribunal simulado sin límite con los criterios de las bases, con tu propio asistente (Claude u otro conectado por MCP)",
    "Solicitudes para cualquier convocatoria, no solo las de tu mes",
  ],
  /** Anchor against a consultancy; uses the live monthly price when RevenueCat returns one. */
  anchor: (monthly = "3,99 €") => `Una consultora se lleva un 10-15 % de tu beca. Con Mecena, ${monthly} al mes.`,
  guarantee: "Garantía: si en 90 días no has presentado 3 solicitudes, te devolvemos el dinero.",
  free: `Gratis siempre: tu perfil, tu dossier, ${FREE_MATCHES_TEXT} y un primer borrador de solicitud para cada una, con tus palabras.`,
  later: "Ahora no",
  bestValue: "Mejor precio",
  mockNote: "Modo prueba: no se cobra nada.",
  mockConfirm: "Confirmar compra de prueba",
  checkoutTitle: "Pago seguro",
  sandboxNote: "Entorno de pruebas de RevenueCat: usa la tarjeta 4242 4242 4242 4242.",
  processing: "Activando tu plan…",
  error: "No se pudo completar la compra. Inténtalo de nuevo.",
  loading: "Cargando los planes…",
  loadError: "No hemos podido cargar los planes. Revisa la conexión.",
  paidNotSynced: "El pago se ha hecho, pero aún no hemos podido activar tu plan. Pulsa «Restaurar compras» en un momento.",
  restore: "Restaurar compras",
  restoring: "Comprobando tus compras…",
  restoreNone: "No hemos encontrado compras activas en esta cuenta.",
  restoreCreditsOnly: (n: number) =>
    `${n === 1 ? "Tienes 1 solicitud premium" : `Tienes ${n} solicitudes premium`}: cada una desbloquea una convocatoria. Úsala desde la convocatoria que quieras; esto es de Mecena Pro.`,
  restoreError: "No hemos podido comprobar tus compras ahora mismo. Inténtalo de nuevo en un momento.",
  premiumReady: "Cada una desbloquea una convocatoria: ábrela y, al adaptar el dossier, preparar la solicitud o pasar el tribunal, pulsa «Usar mi Solicitud premium».",
  premiumReadyLink: "Ver mis convocatorias",
  isPro: "Eres Pro. Todo desbloqueado.",
  credits: (n: number) => (n === 1 ? "Tienes 1 solicitud premium disponible." : `Tienes ${n} solicitudes premium disponibles.`),
  useCredit: "Usar mi Solicitud premium en esta convocatoria",
  usingCredit: "Desbloqueando la convocatoria…",
  creditNote: (n: number) => `Tienes ${n === 1 ? "1 solicitud premium" : `${n} solicitudes premium`} sin usar: desbloquea esta convocatoria sin pagar nada más.`,
} as const;

/** Trigger-specific subtitle: why the paywall appeared right now. */
export const TRIGGER_SUBTITLE: Record<PaywallTrigger, string> = {
  draft_application: "Esta convocatoria no está entre las de tu mes: desbloquéala para preparar su solicitud.",
  match_limit: "Hay más convocatorias que encajan contigo. Desbloquéalas todas.",
  jury: "Pasa tu solicitud por el tribunal todas las veces que quieras antes de presentarla.",
  dossier_variant: "Adapta tu dossier a lo que pide cada convocatoria.",
  pricing_page: "Tú creas. Mecena se encarga del papeleo.",
};

/** Plans in display order; prices are replaced by RevenueCat's formatted prices when live. */
export const PLANS: Plan[] = [
  { id: "proAnnual", title: "Pro anual", priceText: "35,88 €/año", kind: "subscription", period: "P1Y", highlight: true, bullets: ["2,99 € al mes", "ahorras un 25 % frente al mensual"] },
  { id: "proMonthly", title: "Pro mensual", priceText: "3,99 €/mes", kind: "subscription", period: "P1M", bullets: ["Todo Mecena Pro", "Cancela cuando quieras"] },
  {
    id: "solicitudPremium",
    title: "Solicitud premium",
    priceText: "15,00 €",
    kind: "one_off",
    bullets: ["Desbloquea una convocatoria", `su dossier adaptado y ${JURY_RUNS_PER_APPLICATION} pasadas por el tribunal`, "sin suscripción"],
  },
];

export const PERIOD_SUFFIX: Partial<Record<PlanId, string>> = { proMonthly: "/mes", proAnnual: "/año" };

const eur = (amount: number, currency: string) => new Intl.NumberFormat("es-ES", { style: "currency", currency }).format(amount);

/**
 * Plans with live prices (amounts in the currency's units). The annual note is computed from the real prices:
 * per-month equivalent and the saving against 12 monthly payments, so the copy never contradicts the dashboard.
 */
export function plansWithPrices(prices: Partial<Record<PlanId, { amount: number; currency: string }>>): Plan[] {
  const m = prices.proMonthly;
  const a = prices.proAnnual;
  return PLANS.filter((p) => prices[p.id]).map((p) => {
    const price = prices[p.id]!;
    const plan: Plan = { ...p, priceText: `${eur(price.amount, price.currency)}${PERIOD_SUFFIX[p.id] ?? ""}` };
    if (p.id === "proAnnual") {
      const bullets = [`${eur(price.amount / 12, price.currency)} al mes`];
      const saves = !!m && m.currency === price.currency && m.amount * 12 > price.amount;
      if (saves) bullets.push(`ahorras un ${Math.round((1 - price.amount / (m.amount * 12)) * 100)} % frente al mensual`);
      plan.bullets = bullets;
      plan.highlight = saves; // "Mejor precio" only when it is true

    }
    return plan;
  });
}

/**
 * The plans worth offering: a Solicitud premium unlocks one specific call, so it is sold where the paywall was opened
 * for a call (`callId`: its draft, adapted dossier or jury) and on /pro, not where it would unlock nothing (more
 * matches in the feed, deep research).
 */
export function plansFor(trigger: PaywallTrigger, plans: Plan[], callId?: string): Plan[] {
  return callId || trigger === "pricing_page" ? plans : plans.filter((p) => p.kind !== "one_off");
}

/**
 * Whether this entitlement unlocks what the paywall was opened for (after a purchase, "Restaurar compras" or using a
 * credit): Pro, or the call it was opened for unlocked with a Solicitud premium; on /pro, any unused credit.
 */
export function unlocks(trigger: PaywallTrigger, e: Pick<EntitlementState, "pro" | "premiumCredits" | "unlockedCalls">, callId?: string): boolean {
  if (e.pro) return true;
  if (callId) return hasCallAccess(e, callId);
  return trigger === "pricing_page" && e.premiumCredits > 0;
}

/** "3,99 €" out of "3,99 €/mes" (for the anchor). */
export const monthlyPrice = (plans: Plan[]) => plans.find((p) => p.id === "proMonthly")?.priceText.replace(/\/mes$/, "");
