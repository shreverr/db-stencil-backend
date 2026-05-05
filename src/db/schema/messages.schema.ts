import * as p from 'drizzle-orm/pg-core'

/**
 * Per-user AI message balance. Lazy-initialized to FREE_MESSAGES (20) on
 * first read. Each AI turn decrements `balance` by 1. When balance hits 0,
 * AI calls are rejected until the user upgrades or buys a topup pack.
 *
 * Pro renewal grants +N messages (rolls over — not a reset).
 */
export const userMessages = p.pgTable('user_messages', {
  userId: p.uuid('user_id').primaryKey(),
  balance: p.integer('balance').notNull().default(20),
  /** Total messages ever granted (signup + renewals + topups). Audit only. */
  lifetimeGranted: p.integer('lifetime_granted').notNull().default(20),
  updatedAt: p.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** History of message deductions / grants for audit + analytics. */
export const messageLedger = p.pgTable('message_ledger', {
  id: p.uuid('id').primaryKey().defaultRandom(),
  userId: p.uuid('user_id').notNull(),
  delta: p.integer('delta').notNull(), // negative = deduction, positive = grant
  reason: p.text('reason').notNull(),  // e.g. 'ai_chat', 'signup_grant', 'pro_renewal', 'topup_200'
  meta: p.jsonb('meta'),                // freeform: model, tool calls, etc.
  createdAt: p.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
