import * as p from 'drizzle-orm/pg-core'

/**
 * Per-user AI credit balance. Lazy-initialized to FREE_CREDITS (1000) on
 * first read. Each AI generation request decrements `balance`. When balance
 * hits 0, AI calls are rejected until the user tops up.
 */
export const userCredits = p.pgTable('user_credits', {
  userId: p.uuid('user_id').primaryKey(),
  balance: p.integer('balance').notNull().default(1000),
  updatedAt: p.timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** History of credit deductions / grants for audit + future analytics. */
export const creditLedger = p.pgTable('credit_ledger', {
  id: p.uuid('id').primaryKey().defaultRandom(),
  userId: p.uuid('user_id').notNull(),
  delta: p.integer('delta').notNull(), // negative = deduction, positive = grant
  reason: p.text('reason').notNull(),  // e.g. 'ai_chat', 'signup_grant', 'top_up'
  meta: p.jsonb('meta'),                // freeform: model, prompt tokens, etc.
  createdAt: p.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
