import { Context } from 'hono'
import { and, eq, isNull, or, gt } from 'drizzle-orm'
import { db } from '../config/database'
import { shareLinks } from '../db/schema/collaborators.schema'
import { databases } from '../db/schema/databases.schema'
import { schemas } from '../db/schema/schemas.schema'

/**
 * Resolve a public share-link token to a read-only schema snapshot.
 * Unauthenticated. Returns 404 for any token that's missing, expired,
 * revoked, or not flagged `isPublic`.
 */
export async function getPublicSchema(c: Context) {
  try {
    const token = c.req.param('token') ?? ''
    if (!token) return c.json({ error: 'Token required' }, 400)

    const now = new Date()
    const [link] = await db
      .select()
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.token, token),
          eq(shareLinks.isPublic, true),
          isNull(shareLinks.revokedAt),
          or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now))
        )
      )
      .limit(1)
    if (!link) return c.json({ error: 'Invalid or expired link' }, 404)

    const [dbRow] = await db
      .select({
        id: databases.id,
        name: databases.databaseName,
        type: databases.databaseType,
        color: databases.color,
        icon: databases.icon,
      })
      .from(databases)
      .where(eq(databases.id, link.databaseId))
      .limit(1)
    if (!dbRow) return c.json({ error: 'Database missing' }, 404)

    const [schemaRow] = await db
      .select({ dbmlJson: schemas.dbmlJson })
      .from(schemas)
      .where(eq(schemas.databaseid, link.databaseId))
      .limit(1)

    return c.json({
      database: dbRow,
      schema: schemaRow?.dbmlJson ?? { tables: [], edges: [] },
      role: 'viewer' as const,
    })
  } catch (err) {
    console.error('[getPublicSchema]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
