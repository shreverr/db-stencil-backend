/**
 * Single source of truth for the 3 plans + topup packs.
 *
 * AI is metered in *messages* (1 message = 1 AI turn). Free is a lifetime
 * cap with no reset. Pro grants +N messages on each successful renewal
 * (balance rolls over). Enterprise is sales-led with no automated billing.
 */

export type PlanId = 'free' | 'pro' | 'enterprise'
export type Cycle = 'monthly' | 'annual'

export interface PlanFeatures {
  /**
   * Messages granted per billing period. For `free` this is the lifetime cap
   * granted once on signup. For `pro` it's added on each renewal (additive,
   * unused balance rolls over). For `enterprise` resolved at deal time —
   * default 0 here so feature-gating defers to manual provisioning.
   */
  messagesPerPeriod: number
  /** Hard cap on number of active projects (`Infinity` for unlimited). */
  projectLimit: number
  /** May invite editors (true) or only viewers (false). */
  editorCollab: boolean
  /** Public view links allowed. */
  publicLinks: boolean
}

export const PLAN_FEATURES: Record<PlanId, PlanFeatures> = {
  free: {
    messagesPerPeriod: 20,
    projectLimit: 3,
    editorCollab: false,
    publicLinks: true,
  },
  pro: {
    messagesPerPeriod: 250,
    projectLimit: Number.POSITIVE_INFINITY,
    editorCollab: true,
    publicLinks: true,
  },
  enterprise: {
    messagesPerPeriod: 0,
    projectLimit: Number.POSITIVE_INFINITY,
    editorCollab: true,
    publicLinks: true,
  },
}

export interface PlanPriceVariant {
  id: string
  cycle: Cycle
  /** Display price in USD. */
  priceUsd: number
  /** Dodo product id — set in the dashboard, mirrored in env. */
  dodoProductIdEnvKey: string
  /** Messages granted per renewal (also on initial activation). */
  messagesPerPeriod: number
}

/**
 * Pricing variants. Only Pro has paid variants. Free is implicit; Enterprise
 * is sales-led (no Dodo product).
 *
 * Annual = 12× monthly messages granted in one shot at activation/renewal,
 * priced at 10× monthly so users save ~17% vs paying month-to-month.
 */
export const PRICE_VARIANTS: Record<'pro', PlanPriceVariant[]> = {
  pro: [
    { id: 'pro_monthly', cycle: 'monthly', priceUsd: 1,  dodoProductIdEnvKey: 'DODO_PRODUCT_PRO_MONTHLY', messagesPerPeriod: 250  },
    { id: 'pro_annual',  cycle: 'annual',  priceUsd: 10, dodoProductIdEnvKey: 'DODO_PRODUCT_PRO_ANNUAL',  messagesPerPeriod: 3000 },
  ],
}

/**
 * One-shot message topup packs. Carry forever (no expiry).
 */
export interface TopupPack {
  id: string
  messages: number
  priceUsd: number
  dodoProductIdEnvKey: string
}

export const TOPUP_PACKS: TopupPack[] = [
  { id: 'topup_200', messages: 200, priceUsd: 1, dodoProductIdEnvKey: 'DODO_PRODUCT_TOPUP_200' },
]

/** Lookup helpers used elsewhere. */
export function findPriceVariant(variantId: string): PlanPriceVariant | undefined {
  for (const variants of Object.values(PRICE_VARIANTS)) {
    const hit = variants.find((v) => v.id === variantId)
    if (hit) return hit
  }
  return undefined
}

export function planIdForVariant(variantId: string): PlanId | null {
  for (const [plan, variants] of Object.entries(PRICE_VARIANTS) as ['pro', PlanPriceVariant[]][]) {
    if (variants.some((v) => v.id === variantId)) return plan
  }
  return null
}

export function findTopupPack(packId: string): TopupPack | undefined {
  return TOPUP_PACKS.find((p) => p.id === packId)
}
