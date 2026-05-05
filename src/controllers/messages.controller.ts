import { Context } from 'hono'
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { db } from '../config/database'
import { userMessages, messageLedger } from '../db/schema/messages.schema'

/** Lifetime grant for free users — no reset, no monthly refill. */
export const FREE_MESSAGES = 20
/** Cost of one AI generation turn (one user message → assistant response). */
export const COST_PER_AI_TURN = 1

/**
 * Lazy-init: every authenticated user gets `FREE_MESSAGES` on first access.
 * Returns the row (always exists after this call).
 */
export async function ensureMessagesRow(userId: string) {
  const [existing] = await db.select().from(userMessages).where(eq(userMessages.userId, userId)).limit(1)
  if (existing) return existing
  const [row] = await db
    .insert(userMessages)
    .values({ userId, balance: FREE_MESSAGES, lifetimeGranted: FREE_MESSAGES })
    .onConflictDoNothing()
    .returning()
  if (row) {
    await db.insert(messageLedger).values({
      userId,
      delta: FREE_MESSAGES,
      reason: 'signup_grant',
    })
    return row
  }
  // Conflict happened (race) — re-read.
  const [row2] = await db.select().from(userMessages).where(eq(userMessages.userId, userId)).limit(1)
  return row2!
}

/**
 * Atomic deduct. Uses a single UPDATE with WHERE balance >= amount so two
 * concurrent requests can't double-spend the last few messages.
 * Returns new balance, or null if insufficient.
 */
export async function deductMessages(userId: string, amount: number, reason: string, meta?: Record<string, unknown>) {
  if (amount <= 0) return null
  await ensureMessagesRow(userId)
  const result = await db
    .update(userMessages)
    .set({ balance: sql`${userMessages.balance} - ${amount}`, updatedAt: new Date() })
    .where(sql`${userMessages.userId} = ${userId} AND ${userMessages.balance} >= ${amount}`)
    .returning({ balance: userMessages.balance })
  if (result.length === 0) return null
  await db.insert(messageLedger).values({
    userId,
    delta: -amount,
    reason,
    meta: meta ?? null,
  })
  return result[0].balance
}

export async function grantMessages(userId: string, amount: number, reason: string, meta?: Record<string, unknown>) {
  if (amount <= 0) return null
  await ensureMessagesRow(userId)
  const [row] = await db
    .update(userMessages)
    .set({
      balance: sql`${userMessages.balance} + ${amount}`,
      lifetimeGranted: sql`${userMessages.lifetimeGranted} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(userMessages.userId, userId))
    .returning({ balance: userMessages.balance })
  await db.insert(messageLedger).values({ userId, delta: amount, reason, meta: meta ?? null })
  return row?.balance ?? null
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

/** GET /api/v1/messages */
export async function getMyMessages(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const row = await ensureMessagesRow(userId)
    return c.json({ balance: row.balance, costPerTurn: COST_PER_AI_TURN })
  } catch (err) {
    console.error('[getMyMessages]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

const deductSchema = z.object({
  amount: z.number().int().positive().max(100),
  reason: z.string().min(1).max(100),
  meta: z.record(z.string(), z.unknown()).optional(),
})

/** POST /api/v1/messages/deduct  body: { amount, reason, meta? } */
export async function deductMyMessages(c: Context) {
  try {
    const userId = c.get('user').sub as string
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const parsed = deductSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation failed' }, 400)

    const newBalance = await deductMessages(userId, parsed.data.amount, parsed.data.reason, parsed.data.meta)
    if (newBalance === null) {
      const row = await ensureMessagesRow(userId)
      return c.json({ error: 'Insufficient messages', balance: row.balance, required: parsed.data.amount }, 402)
    }
    return c.json({ ok: true, balance: newBalance })
  } catch (err) {
    console.error('[deductMyMessages]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

const refundSchema = z.object({
  amount: z.number().int().positive().max(100),
  reason: z.string().min(1).max(100),
})

/**
 * POST /api/v1/messages/refund — credit back a previously-deducted amount.
 * Used by the AI chat route when a turn produces zero successful tool calls
 * so the user doesn't pay for a no-op response.
 */
export async function refundMyMessages(c: Context) {
  try {
    const userId = c.get('user').sub as string
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const parsed = refundSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation failed' }, 400)
    const newBalance = await grantMessages(userId, parsed.data.amount, `refund:${parsed.data.reason}`)
    return c.json({ ok: true, balance: newBalance ?? 0 })
  } catch (err) {
    console.error('[refundMyMessages]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
