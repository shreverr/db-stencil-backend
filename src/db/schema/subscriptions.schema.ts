import * as p from 'drizzle-orm/pg-core'

export const planEnum = p.pgEnum('plan', ['free', 'pro', 'limitless'])
export const cycleEnum = p.pgEnum('billing_cycle', ['monthly', 'annual', 'lifetime'])
export const subStatusEnum = p.pgEnum('subscription_status', [
  'active',
  'canceled',
  'past_due',
  'incomplete',
  'expired',
])

/**
 * One row per user. Lazy-init: a user with no row is implicitly on the free
 * plan. Limitless is one-time (no period_end). Pro carries a current_period_end
 * which Dodo's webhook bumps on each renewal.
 */
export const subscriptions = p.pgTable('subscriptions', {
  userId: p.uuid('user_id').primaryKey(),
  plan: planEnum('plan').notNull().default('free'),
  status: subStatusEnum('status').notNull().default('active'),
  cycle: cycleEnum('cycle'),
  dodoCustomerId: p.text('dodo_customer_id'),
  dodoSubscriptionId: p.text('dodo_subscription_id'),
  // For lifetime purchases — track which payment closed the deal.
  dodoPaymentId: p.text('dodo_payment_id'),
  currentPeriodEnd: p.timestamp('current_period_end', { withTimezone: true }),
  cancelAtPeriodEnd: p.boolean('cancel_at_period_end').notNull().default(false),
  createdAt: p.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: p.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Audit trail of payment / subscription events received from Dodo.
 * Useful for debugging and as the source of truth for receipts.
 */
export const billingEvents = p.pgTable('billing_events', {
  id: p.uuid('id').primaryKey().defaultRandom(),
  userId: p.uuid('user_id'),
  eventType: p.text('event_type').notNull(),
  dodoEventId: p.text('dodo_event_id'),
  payload: p.jsonb('payload').notNull(),
  createdAt: p.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
