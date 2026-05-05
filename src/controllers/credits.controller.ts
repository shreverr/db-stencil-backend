import { Context } from 'hono'
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { db } from '../config/database'
import { userCredits, creditLedger } from '../db/schema/credits.schema'

export const FREE_CREDITS = 1000
/** Cost of one AI generation turn (one user message → assistant response). */
export const COST_PER_AI_TURN = 300

/**
 * Lazy-init: every authenticated user gets `FREE_CREDITS` on first access.
 * Returns the row (always exists after this call).
 */
export async function ensureCreditsRow(userId: string) {
  const [existing] = await db.select().from(userCredits).where(eq(userCredits.userId, userId)).limit(1)
  if (existing) return existing
  const [row] = await db
    .insert(userCredits)
    .values({ userId, balance: FREE_CREDITS })
    .onConflictDoNothing()
    .returning()
  if (row) {
    await db.insert(creditLedger).values({
      userId,
      delta: FREE_CREDITS,
      reason: 'signup_grant',
    })
    return row
  }
  // Conflict happened (race) — re-read.
  const [row2] = await db.select().from(userCredits).where(eq(userCredits.userId, userId)).limit(1)
  return row2!
}

/**
 * Atomic deduct. Uses a single UPDATE with WHERE balance >= amount so two
 * concurrent requests can't double-spend the last few credits.
 * Returns new balance, or null if insufficient.
 */
export async function deductCredits(userId: string, amount: number, reason: string, meta?: Record<string, unknown>) {
  if (amount <= 0) return null
  await ensureCreditsRow(userId)
  const result = await db
    .update(userCredits)
    .set({ balance: sql`${userCredits.balance} - ${amount}`, updatedAt: new Date() })
    .where(sql`${userCredits.userId} = ${userId} AND ${userCredits.balance} >= ${amount}`)
    .returning({ balance: userCredits.balance })
  if (result.length === 0) return null
  await db.insert(creditLedger).values({
    userId,
    delta: -amount,
    reason,
    meta: meta ?? null,
  })
  return result[0].balance
}

export async function grantCredits(userId: string, amount: number, reason: string) {
  if (amount <= 0) return null
  await ensureCreditsRow(userId)
  const [row] = await db
    .update(userCredits)
    .set({ balance: sql`${userCredits.balance} + ${amount}`, updatedAt: new Date() })
    .where(eq(userCredits.userId, userId))
    .returning({ balance: userCredits.balance })
  await db.insert(creditLedger).values({ userId, delta: amount, reason })
  return row?.balance ?? null
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

/** GET /api/v1/credits */
export async function getMyCredits(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const row = await ensureCreditsRow(userId)
    return c.json({ balance: row.balance, costPerTurn: COST_PER_AI_TURN })
  } catch (err) {
    console.error('[getMyCredits]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

const deductSchema = z.object({
  amount: z.number().int().positive().max(10_000),
  reason: z.string().min(1).max(100),
  meta: z.record(z.string(), z.unknown()).optional(),
})

/** POST /api/v1/credits/deduct  body: { amount, reason, meta? } */
export async function deductMyCredits(c: Context) {
  try {
    const userId = c.get('user').sub as string
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const parsed = deductSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation failed' }, 400)

    const newBalance = await deductCredits(userId, parsed.data.amount, parsed.data.reason, parsed.data.meta)
    if (newBalance === null) {
      const row = await ensureCreditsRow(userId)
      return c.json({ error: 'Insufficient credits', balance: row.balance, required: parsed.data.amount }, 402)
    }
    return c.json({ ok: true, balance: newBalance })
  } catch (err) {
    console.error('[deductMyCredits]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

const refundSchema = z.object({
  amount: z.number().int().positive().max(10_000),
  reason: z.string().min(1).max(100),
})

/**
 * POST /api/v1/credits/refund — credit back a previously-deducted amount.
 * Used by the AI chat route when a turn produces zero successful tool calls
 * (model narrated instead of invoking, gateway timeout, etc.) so the user
 * doesn't pay for a no-op response.
 */
export async function refundMyCredits(c: Context) {
  try {
    const userId = c.get('user').sub as string
    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const parsed = refundSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation failed' }, 400)
    const newBalance = await grantCredits(userId, parsed.data.amount, `refund:${parsed.data.reason}`)
    return c.json({ ok: true, balance: newBalance ?? 0 })
  } catch (err) {
    console.error('[refundMyCredits]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
