import { Context } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../config/database'
import { subscriptions, billingEvents } from '../db/schema/subscriptions.schema'
import { userCredits } from '../db/schema/credits.schema'
import { ensureSubscription, getUserPlan } from '../lib/billing'
import {
  PLAN_FEATURES,
  PRICE_VARIANTS,
  TOPUP_PACKS,
  findPriceVariant,
  findTopupPack,
  planIdForVariant,
} from '../lib/plans'
import { createPaymentCheckout, createSubscriptionCheckout, verifyWebhookSignature } from '../lib/dodo'
import { grantCredits } from './credits.controller'
import { env } from '../config/env'

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/billing/me
 * Returns the user's current plan, plan features, and credit balance.
 */
export async function getMyBilling(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const sub = await ensureSubscription(userId)
    const plan = await getUserPlan(userId)
    const [credits] = await db.select().from(userCredits).where(eq(userCredits.userId, userId)).limit(1)
    return c.json({
      plan,
      planFeatures: PLAN_FEATURES[plan],
      status: sub.status,
      cycle: sub.cycle,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      credits: credits?.balance ?? 0,
    })
  } catch (err) {
    console.error('[getMyBilling]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

/**
 * GET /api/v1/billing/plans
 * Public-shaped (still auth-gated for simplicity) catalog used by the
 * frontend pricing page.
 */
export async function getPlanCatalog(c: Context) {
  return c.json({
    plans: {
      free: { features: PLAN_FEATURES.free },
      pro: { features: PLAN_FEATURES.pro, variants: PRICE_VARIANTS.pro },
      limitless: { features: PLAN_FEATURES.limitless, variants: PRICE_VARIANTS.limitless },
    },
    topups: TOPUP_PACKS.map((p) => ({ id: p.id, credits: p.credits, priceUsd: p.priceUsd })),
  })
}

// ── Checkout ──────────────────────────────────────────────────────────────────

const checkoutSchema = z.object({
  variantId: z.string().min(1),
})

/**
 * POST /api/v1/billing/checkout  body: { variantId }
 * Creates a Dodo checkout for the requested plan variant. Returns the
 * hosted payment link the frontend redirects to.
 */
export async function startCheckout(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const email = (c.get('user').email as string | undefined) ?? ''

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const parsed = checkoutSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation failed' }, 400)

    const variant = findPriceVariant(parsed.data.variantId)
    if (!variant) return c.json({ error: 'Unknown variant' }, 400)

    const productId = process.env[variant.dodoProductIdEnvKey]
    if (!productId) {
      return c.json({
        error: `${variant.dodoProductIdEnvKey} not configured`,
        message: 'Pricing not yet wired — contact admin.',
      }, 500)
    }

    const planId = planIdForVariant(variant.id)
    const returnUrl = `${env.FRONTEND_URL}/billing/return?variant=${variant.id}`
    const metadata = {
      user_id: userId,
      variant_id: variant.id,
      plan_id: planId ?? 'unknown',
      cycle: variant.cycle,
    }

    const result = variant.cycle === 'lifetime'
      ? await createPaymentCheckout({ productId, customer: { email }, metadata, returnUrl })
      : await createSubscriptionCheckout({ productId, customer: { email }, metadata, returnUrl })

    return c.json({ url: result.payment_link, paymentId: result.payment_id, subscriptionId: result.subscription_id })
  } catch (err) {
    console.error('[startCheckout]', err)
    return c.json({ error: (err as Error).message ?? 'Checkout failed' }, 500)
  }
}

const topupSchema = z.object({ packId: z.string().min(1) })

/**
 * POST /api/v1/billing/topup  body: { packId }
 * One-shot credit topup. Always uses one-time payment, regardless of plan.
 */
export async function startTopup(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const email = (c.get('user').email as string | undefined) ?? ''

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const parsed = topupSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation failed' }, 400)

    const pack = findTopupPack(parsed.data.packId)
    if (!pack) return c.json({ error: 'Unknown topup pack' }, 400)

    const productId = process.env[pack.dodoProductIdEnvKey]
    if (!productId) {
      return c.json({ error: `${pack.dodoProductIdEnvKey} not configured` }, 500)
    }

    const result = await createPaymentCheckout({
      productId,
      customer: { email },
      metadata: {
        user_id: userId,
        kind: 'topup',
        pack_id: pack.id,
        credits: String(pack.credits),
      },
      returnUrl: `${env.FRONTEND_URL}/billing/return?topup=${pack.id}`,
    })

    return c.json({ url: result.payment_link, paymentId: result.payment_id })
  } catch (err) {
    console.error('[startTopup]', err)
    return c.json({ error: (err as Error).message ?? 'Topup failed' }, 500)
  }
}

// ── Webhook ───────────────────────────────────────────────────────────────────

interface DodoWebhookEvent {
  // Dodo's exact shape varies; we tolerate a few field names defensively.
  type?: string
  event_type?: string
  id?: string
  data?: {
    payload_type?: string
    metadata?: Record<string, string>
    customer?: { customer_id?: string; email?: string }
    subscription_id?: string
    payment_id?: string
    status?: string
    next_billing_date?: string
    current_period_end?: string
    product_id?: string
  }
  // Some payloads inline at root; fallbacks.
  metadata?: Record<string, string>
  payment_id?: string
  subscription_id?: string
}

/**
 * POST /api/v1/webhooks/dodo
 * Verifies signature, persists raw event for audit, then routes by event type.
 */
export async function handleDodoWebhook(c: Context) {
  const raw = await c.req.text()
  const sig = c.req.header('webhook-signature') ?? c.req.header('x-webhook-signature')

  // In dev (no secret configured) we accept unverified events so local
  // testing isn't blocked. Production REQUIRES a configured secret.
  if (env.DODO_WEBHOOK_SECRET && !verifyWebhookSignature(raw, sig)) {
    return c.json({ error: 'Invalid signature' }, 401)
  }

  let event: DodoWebhookEvent
  try { event = JSON.parse(raw) } catch { return c.json({ error: 'Invalid JSON' }, 400) }

  const type = event.type ?? event.event_type ?? 'unknown'
  const meta = event.metadata ?? event.data?.metadata ?? {}
  const userId = meta.user_id

  // Persist for audit before mutation. Dodo events are dedupable by `id`.
  await db.insert(billingEvents).values({
    userId: userId ?? null,
    eventType: type,
    dodoEventId: event.id ?? null,
    payload: event as unknown as Record<string, unknown>,
  })

  if (!userId) {
    console.warn('[dodo-webhook] event missing user_id metadata', type, event.id)
    return c.json({ ok: true, ignored: 'no user_id' })
  }

  try {
    switch (type) {
      // ── Subscription lifecycle (Pro) ────────────────────────────────
      case 'subscription.active':
      case 'subscription.created':
      case 'subscription.renewed':
      case 'subscription.updated': {
        const subId = event.data?.subscription_id ?? event.subscription_id ?? null
        const customerId = event.data?.customer?.customer_id ?? null
        const periodEnd = event.data?.next_billing_date ?? event.data?.current_period_end ?? null
        const variantId = meta.variant_id
        const planId = meta.plan_id === 'pro' ? 'pro' : meta.plan_id === 'limitless' ? 'limitless' : null
        if (!planId) break

        const cycle = meta.cycle === 'annual' ? 'annual' : meta.cycle === 'monthly' ? 'monthly' : 'lifetime'
        await db
          .insert(subscriptions)
          .values({
            userId,
            plan: planId,
            status: 'active',
            cycle: cycle as 'monthly' | 'annual' | 'lifetime',
            dodoSubscriptionId: subId,
            dodoCustomerId: customerId,
            currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
            cancelAtPeriodEnd: false,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: subscriptions.userId,
            set: {
              plan: planId,
              status: 'active',
              cycle: cycle as 'monthly' | 'annual' | 'lifetime',
              dodoSubscriptionId: subId,
              dodoCustomerId: customerId,
              currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
              cancelAtPeriodEnd: false,
              updatedAt: new Date(),
            },
          })

        // Grant credits on first activation + each renewal.
        if (type === 'subscription.active' || type === 'subscription.created' || type === 'subscription.renewed') {
          const credits = PLAN_FEATURES[planId].aiCreditsPerPeriod
          await grantCredits(userId, credits, `${planId}_${cycle}_grant`)
        }
        // Variant id stored in audit log via the billingEvents row above.
        void variantId
        break
      }

      case 'subscription.canceled':
      case 'subscription.cancelled':
      case 'subscription.expired': {
        await db
          .update(subscriptions)
          .set({
            status: type.includes('expired') ? 'expired' : 'canceled',
            cancelAtPeriodEnd: true,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.userId, userId))
        break
      }

      case 'subscription.failed':
      case 'subscription.past_due': {
        await db
          .update(subscriptions)
          .set({ status: 'past_due', updatedAt: new Date() })
          .where(eq(subscriptions.userId, userId))
        break
      }

      // ── One-time payments (Limitless + topups) ─────────────────────
      case 'payment.succeeded':
      case 'payment.completed': {
        const paymentId = event.data?.payment_id ?? event.payment_id ?? null

        if (meta.kind === 'topup') {
          const credits = parseInt(meta.credits ?? '0', 10)
          if (credits > 0) {
            await grantCredits(userId, credits, `topup_${meta.pack_id ?? 'unknown'}`)
          }
          break
        }

        // Otherwise this is a one-time plan purchase (Limitless).
        if (meta.plan_id === 'limitless') {
          await db
            .insert(subscriptions)
            .values({
              userId,
              plan: 'limitless',
              status: 'active',
              cycle: 'lifetime',
              dodoPaymentId: paymentId,
              currentPeriodEnd: null,
              cancelAtPeriodEnd: false,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: subscriptions.userId,
              set: {
                plan: 'limitless',
                status: 'active',
                cycle: 'lifetime',
                dodoPaymentId: paymentId,
                currentPeriodEnd: null,
                cancelAtPeriodEnd: false,
                updatedAt: new Date(),
              },
            })
          await grantCredits(userId, PLAN_FEATURES.limitless.aiCreditsPerPeriod, 'limitless_lifetime_grant')
        }
        break
      }

      default:
        // Unhandled — already audit-logged above.
        break
    }
    return c.json({ ok: true })
  } catch (err) {
    console.error('[dodo-webhook] handler error', type, err)
    return c.json({ error: 'Handler error' }, 500)
  }
}
