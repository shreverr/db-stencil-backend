import { eq, and, or } from 'drizzle-orm'
import { db } from '../config/database'
import { databases } from '../db/schema/databases.schema'
import { collaborators } from '../db/schema/collaborators.schema'

export type AccessRole = 'owner' | 'editor' | 'viewer'

const ROLE_RANK: Record<AccessRole, number> = {
  owner: 3,
  editor: 2,
  viewer: 1,
}

/**
 * Returns the effective role of `userId` on `databaseId`, or `null` if no access.
 * Owner is derived from `databases.userid`; other roles come from `collaborators`.
 */
export async function getDatabaseRole(
  databaseId: string,
  userId: string
): Promise<AccessRole | null> {
  const dbRow = await db
    .select({ userid: databases.userid })
    .from(databases)
    .where(eq(databases.id, databaseId))
    .limit(1)
  if (dbRow.length === 0) return null
  if (dbRow[0].userid === userId) return 'owner'

  const collabRow = await db
    .select({ role: collaborators.role })
    .from(collaborators)
    .where(
      and(eq(collaborators.databaseId, databaseId), eq(collaborators.userId, userId))
    )
    .limit(1)
  if (collabRow.length === 0) return null
  return collabRow[0].role
}

/** True iff `userId` has at least `min` role on the database. */
export async function userHasAccess(
  databaseId: string,
  userId: string,
  min: AccessRole = 'viewer'
): Promise<boolean> {
  const role = await getDatabaseRole(databaseId, userId)
  if (!role) return false
  return ROLE_RANK[role] >= ROLE_RANK[min]
}
