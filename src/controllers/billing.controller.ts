import { Context } from 'hono'
import { z } from 'zod'
import { eq, and, sql } from 'drizzle-orm'
import { db } from '../config/database'
import { subscriptions, billingEvents } from '../db/schema/subscriptions.schema'
import { userMessages, messageLedger } from '../db/schema/messages.schema'
import { ensureSubscription, getUserPlan } from '../lib/billing'
import {
  PLAN_FEATURES,
  PRICE_VARIANTS,
  TOPUP_PACKS,
  findPriceVariant,
  findTopupPack,
  planIdForVariant,
  type PlanFeatures,
} from '../lib/plans'

/**
 * `Number.POSITIVE_INFINITY` does not survive `JSON.stringify` — it becomes
 * `null`. Translate Infinity → `null` (and let `null` keep meaning "no
 * limit") so the wire shape is JSON-safe and the frontend can branch
 * cleanly on `value === null` without the value being indistinguishable
 * from a default-fallback.
 */
function wireFeatures(f: PlanFeatures) {
  return {
    messagesPerPeriod: f.messagesPerPeriod,
    projectLimit: Number.isFinite(f.projectLimit) ? f.projectLimit : null,
    editorCollab: f.editorCollab,
    publicLinks: f.publicLinks,
  }
}
import { createSubscriptionCheckout, createPaymentCheckout, verifyWebhookSignature } from '../lib/dodo'
import { grantMessages } from './messages.controller'
import { env } from '../config/env'

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/billing/me
 * Returns the user's current plan, plan features, and message balance.
 */
export async function getMyBilling(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const sub = await ensureSubscription(userId)
    const plan = await getUserPlan(userId)
    const [msgs] = await db.select().from(userMessages).where(eq(userMessages.userId, userId)).limit(1)
    return c.json({
      plan,
      planFeatures: wireFeatures(PLAN_FEATURES[plan]),
      status: sub.status,
      cycle: sub.cycle,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      messages: msgs?.balance ?? 0,
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
      free: { features: wireFeatures(PLAN_FEATURES.free) },
      pro: { features: wireFeatures(PLAN_FEATURES.pro), variants: PRICE_VARIANTS.pro },
      enterprise: { features: wireFeatures(PLAN_FEATURES.enterprise) },
    },
    topups: TOPUP_PACKS.map((p) => ({ id: p.id, messages: p.messages, priceUsd: p.priceUsd })),
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
    const user = c.get('user') as { email?: string; user_metadata?: { full_name?: string; name?: string } }
    const email = user.email ?? ''
    const name = user.user_metadata?.full_name ?? user.user_metadata?.name ?? email.split('@')[0] ?? 'Customer'

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
      messages_per_period: String(variant.messagesPerPeriod),
    }

    const result = await createSubscriptionCheckout({ productId, customer: { email, name }, metadata, returnUrl })

    return c.json({ url: result.payment_link, paymentId: result.payment_id, subscriptionId: result.subscription_id })
  } catch (err) {
    console.error('[startCheckout]', err)
    return c.json({ error: (err as Error).message ?? 'Checkout failed' }, 500)
  }
}

const topupSchema = z.object({ packId: z.string().min(1) })

/**
 * POST /api/v1/billing/topup  body: { packId }
 * One-shot message topup. Always uses one-time payment, regardless of plan.
 */
export async function startTopup(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const user = c.get('user') as { email?: string; user_metadata?: { full_name?: string; name?: string } }
    const email = user.email ?? ''
    const name = user.user_metadata?.full_name ?? user.user_metadata?.name ?? email.split('@')[0] ?? 'Customer'

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
      customer: { email, name },
      metadata: {
        user_id: userId,
        kind: 'topup',
        pack_id: pack.id,
        messages: String(pack.messages),
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
  // Dodo wraps Svix — three headers carry the verification material.
  const msgId = c.req.header('webhook-id')
  const timestamp = c.req.header('webhook-timestamp')
  const signatureHeader = c.req.header('webhook-signature')

  // In dev (no secret configured) we accept unverified events so local
  // testing isn't blocked. Production REQUIRES a configured secret.
  if (env.DODO_WEBHOOK_SECRET) {
    const result = verifyWebhookSignature({ body: raw, msgId, timestamp, signatureHeader })
    if (!result.ok) {
      console.warn('[dodo-webhook] signature failed:', result.reason, 'msgId=', msgId)
      return c.json({ error: 'Invalid signature', reason: result.reason }, 401)
    }
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
        if (meta.plan_id !== 'pro') break

        // Cycle comes from checkout metadata (set by startCheckout from the
        // resolved variant). Fall back to monthly so legacy events from
        // before annual launched still write a valid value.
        const cycle: 'monthly' | 'annual' = meta.cycle === 'annual' ? 'annual' : 'monthly'

        await db
          .insert(subscriptions)
          .values({
            userId,
            plan: 'pro',
            status: 'active',
            cycle,
            dodoSubscriptionId: subId,
            dodoCustomerId: customerId,
            currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
            cancelAtPeriodEnd: false,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: subscriptions.userId,
            set: {
              plan: 'pro',
              status: 'active',
              cycle,
              dodoSubscriptionId: subId,
              dodoCustomerId: customerId,
              currentPeriodEnd: periodEnd ? new Date(periodEnd) : null,
              cancelAtPeriodEnd: false,
              updatedAt: new Date(),
            },
          })

        // Grant messages on first activation + each renewal.
        // Dodo fires `subscription.active` AND `subscription.renewed` for the
        // same initial purchase (we observed this empirically). Dedupe by
        // checking if a Pro grant landed for this user in the last 90s — if
        // so, skip; the prior event already credited this period.
        if (type === 'subscription.active' || type === 'subscription.created' || type === 'subscription.renewed') {
          const recent = await db
            .select({ id: messageLedger.id })
            .from(messageLedger)
            .where(
              and(
                eq(messageLedger.userId, userId),
                sql`${messageLedger.reason} LIKE 'pro_%'`,
                sql`${messageLedger.createdAt} > NOW() - INTERVAL '90 seconds'`,
              ),
            )
            .limit(1)
          if (recent.length === 0) {
            const grant = parseInt(meta.messages_per_period ?? '0', 10) || PLAN_FEATURES.pro.messagesPerPeriod
            await grantMessages(userId, grant, `pro_${type === 'subscription.renewed' ? 'renewal' : 'activation'}`)
          } else {
            console.info('[dodo-webhook] dedupe: skipping duplicate pro grant for user', userId, 'event type=', type)
          }
        }
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
      case 'subscription.past_due':
      case 'subscription.on_hold': {
        await db
          .update(subscriptions)
          .set({ status: 'past_due', updatedAt: new Date() })
          .where(eq(subscriptions.userId, userId))
        break
      }

      // ── One-time payments (topups) ─────────────────────────────────
      case 'payment.succeeded':
      case 'payment.completed': {
        if (meta.kind === 'topup') {
          const paymentId = event.data?.payment_id ?? event.payment_id ?? null
          // Dedupe by Dodo `payment_id` — same payment can be redelivered.
          if (paymentId) {
            const dup = await db
              .select({ id: messageLedger.id })
              .from(messageLedger)
              .where(
                and(
                  eq(messageLedger.userId, userId),
                  sql`${messageLedger.meta}->>'payment_id' = ${paymentId}`,
                ),
              )
              .limit(1)
            if (dup.length > 0) {
              console.info('[dodo-webhook] dedupe: topup payment already credited', paymentId)
              break
            }
          }
          const messages = parseInt(meta.messages ?? '0', 10)
          if (messages > 0) {
            await grantMessages(
              userId,
              messages,
              `topup_${meta.pack_id ?? 'unknown'}`,
              { payment_id: paymentId },
            )
          }
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
