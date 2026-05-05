import { eq } from 'drizzle-orm'
import { db } from '../config/database'
import { subscriptions } from '../db/schema/subscriptions.schema'
import { PLAN_FEATURES, type PlanId, type PlanFeatures } from './plans'

/**
 * Ensures a subscription row exists for the user. Defaults to free / active.
 * Returns the row.
 */
export async function ensureSubscription(userId: string) {
  const [existing] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1)
  if (existing) return existing
  const [row] = await db
    .insert(subscriptions)
    .values({ userId, plan: 'free', status: 'active' })
    .onConflictDoNothing()
    .returning()
  if (row) return row
  const [row2] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).limit(1)
  return row2!
}

/**
 * Resolves the user's effective plan, taking subscription status + period
 * end into account. A canceled / expired pro user falls back to free.
 */
export async function getUserPlan(userId: string): Promise<PlanId> {
  const sub = await ensureSubscription(userId)
  if (sub.plan === 'free') return 'free'
  if (sub.status !== 'active') return 'free'
  // Limitless is one-time — no period boundary check.
  if (sub.plan === 'limitless') return 'limitless'
  // Pro must have a non-expired period.
  if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() < Date.now()) return 'free'
  return sub.plan
}

export async function getUserPlanFeatures(userId: string): Promise<PlanFeatures & { plan: PlanId }> {
  const plan = await getUserPlan(userId)
  return { plan, ...PLAN_FEATURES[plan] }
}
