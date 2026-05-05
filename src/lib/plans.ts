/**
 * Single source of truth for the 3 plans + topup packs.
 *
 * Plan grant amounts are credited on subscription create + each renewal
 * via the Dodo webhook handler.
 */

export type PlanId = 'free' | 'pro' | 'limitless'
export type Cycle = 'monthly' | 'annual' | 'lifetime'

export interface PlanFeatures {
  /** AI credits granted per billing period (monthly for pro, lifetime for limitless). */
  aiCreditsPerPeriod: number
  /** Hard cap on number of active projects (`Infinity` for unlimited). */
  projectLimit: number
  /** May invite editors (true) or only viewers (false). */
  editorCollab: boolean
  /** Public view links allowed. */
  publicLinks: boolean
}

export const PLAN_FEATURES: Record<PlanId, PlanFeatures> = {
  free: {
    aiCreditsPerPeriod: 1_000,
    projectLimit: 3,
    editorCollab: false,
    publicLinks: true,
  },
  pro: {
    aiCreditsPerPeriod: 100_000,
    projectLimit: Number.POSITIVE_INFINITY,
    editorCollab: true,
    publicLinks: true,
  },
  limitless: {
    aiCreditsPerPeriod: 1_000_000,
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
}

/**
 * Pricing variants for the 3 plans. Free has no price variants.
 * Pro is recurring (monthly / annual). Limitless is one-time (lifetime).
 */
export const PRICE_VARIANTS: Record<Exclude<PlanId, 'free'>, PlanPriceVariant[]> = {
  pro: [
    { id: 'pro_monthly', cycle: 'monthly', priceUsd: 1,  dodoProductIdEnvKey: 'DODO_PRODUCT_PRO_MONTHLY' },
    { id: 'pro_annual',  cycle: 'annual',  priceUsd: 10, dodoProductIdEnvKey: 'DODO_PRODUCT_PRO_ANNUAL'  },
  ],
  limitless: [
    { id: 'limitless_lifetime', cycle: 'lifetime', priceUsd: 49, dodoProductIdEnvKey: 'DODO_PRODUCT_LIMITLESS' },
  ],
}

/**
 * One-shot AI credit topup packs for users who blow through their monthly budget.
 * All cycles are 'lifetime' (one-time payment, credits never expire).
 */
export interface TopupPack {
  id: string
  credits: number
  priceUsd: number
  dodoProductIdEnvKey: string
}

export const TOPUP_PACKS: TopupPack[] = [
  { id: 'topup_small',  credits: 50_000,  priceUsd: 5,  dodoProductIdEnvKey: 'DODO_PRODUCT_TOPUP_SMALL'  },
  { id: 'topup_medium', credits: 200_000, priceUsd: 15, dodoProductIdEnvKey: 'DODO_PRODUCT_TOPUP_MEDIUM' },
  { id: 'topup_large',  credits: 500_000, priceUsd: 30, dodoProductIdEnvKey: 'DODO_PRODUCT_TOPUP_LARGE'  },
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
  for (const [plan, variants] of Object.entries(PRICE_VARIANTS) as [Exclude<PlanId, 'free'>, PlanPriceVariant[]][]) {
    if (variants.some((v) => v.id === variantId)) return plan
  }
  return null
}

export function findTopupPack(packId: string): TopupPack | undefined {
  return TOPUP_PACKS.find((p) => p.id === packId)
}
