import * as p from 'drizzle-orm/pg-core'

/**
 * Inbound enterprise contact-form submissions. We don't process payment for
 * enterprise — sales follows up manually via the address in the lead row.
 */
export const enterpriseLeads = p.pgTable('enterprise_leads', {
  id: p.uuid('id').primaryKey().defaultRandom(),
  /** Optional — null when submitted by an unauthenticated visitor. */
  userId: p.uuid('user_id'),
  name: p.text('name').notNull(),
  email: p.text('email').notNull(),
  company: p.text('company'),
  teamSize: p.text('team_size'),
  message: p.text('message').notNull(),
  status: p.text('status').notNull().default('new'), // new | contacted | won | lost
  createdAt: p.timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
