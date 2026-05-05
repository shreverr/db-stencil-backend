import * as p from 'drizzle-orm/pg-core'
import { databases } from './databases.schema'

export const collaboratorRole = p.pgEnum('collaborator_role', ['owner', 'editor', 'viewer'])

export const collaborators = p.pgTable(
  'collaborators',
  {
    databaseId: p
      .uuid('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    userId: p.uuid('user_id').notNull(),
    role: collaboratorRole('role').notNull().default('editor'),
    addedAt: p.timestamp('added_at').notNull().defaultNow(),
    addedBy: p.uuid('added_by'),
  },
  (t) => ({
    pk: p.primaryKey({ columns: [t.databaseId, t.userId] }),
    userIdx: p.index('collaborators_user_idx').on(t.userId),
  })
)

export const shareLinks = p.pgTable('share_links', {
  token: p.text('token').primaryKey(),
  databaseId: p
    .uuid('database_id')
    .notNull()
    .references(() => databases.id, { onDelete: 'cascade' }),
  role: collaboratorRole('role').notNull().default('editor'),
  /**
   * When true, this link can be opened without auth and grants read-only view
   * of the schema. Public links are always viewer-role; the consumer endpoint
   * (`/public/schemas/:token`) returns the schema without going through the
   * collaborators table.
   */
  isPublic: p.boolean('is_public').notNull().default(false),
  createdBy: p.uuid('created_by').notNull(),
  createdAt: p.timestamp('created_at').notNull().defaultNow(),
  expiresAt: p.timestamp('expires_at'),
  revokedAt: p.timestamp('revoked_at'),
})

export const databaseInvites = p.pgTable(
  'database_invites',
  {
    databaseId: p
      .uuid('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    email: p.text('email').notNull(),
    role: collaboratorRole('role').notNull().default('editor'),
    invitedBy: p.uuid('invited_by').notNull(),
    invitedAt: p.timestamp('invited_at').notNull().defaultNow(),
    claimedAt: p.timestamp('claimed_at'),
    claimedByUserId: p.uuid('claimed_by_user_id'),
  },
  (t) => ({
    pk: p.primaryKey({ columns: [t.databaseId, t.email] }),
    emailIdx: p.index('database_invites_email_idx').on(t.email),
  })
)
