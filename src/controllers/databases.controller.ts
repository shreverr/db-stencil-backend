import { Context } from 'hono'
import { z } from 'zod'
import { eq, and, or, inArray } from 'drizzle-orm'
import { db } from '../config/database'
import { databases } from '../db/schema/databases.schema'
import { schemas } from '../db/schema/schemas.schema'
import { collaborators } from '../db/schema/collaborators.schema'
import { userHasAccess } from '../lib/access'
import { getUserPlanFeatures } from '../lib/billing'

const createSchema = z.object({
  databaseName: z.string().min(1, 'databaseName is required'),
  databaseType: z.enum(['postgres']),
  color: z.string().min(1, 'color is required'),
  icon: z.string().optional(),
  starred: z.boolean().optional(),
})

const updateSchema = createSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' }
)

const uuidSchema = z.string().uuid('Invalid id format')

export async function listDatabases(c: Context) {
  try {
    const userId = c.get('user').sub as string

    // Owned databases
    const owned = await db
      .select()
      .from(databases)
      .where(eq(databases.userid, userId))

    // Databases shared with this user
    const collabRows = await db
      .select({ databaseId: collaborators.databaseId })
      .from(collaborators)
      .where(eq(collaborators.userId, userId))
    const sharedIds = collabRows.map((r) => r.databaseId).filter((id) => !owned.find((o) => o.id === id))
    const shared = sharedIds.length > 0
      ? await db.select().from(databases).where(inArray(databases.id, sharedIds))
      : []

    const all = [...owned, ...shared]
    if (all.length === 0) return c.json([])

    // Fetch every collaborator userId for the listed databases in one query,
    // group by databaseId, and inline into each row so the workspace UI can
    // show a "shared with you" tag + avatar stack without further round-trips.
    const dbIds = all.map((d) => d.id)
    const allCollabs = await db
      .select({ databaseId: collaborators.databaseId, userId: collaborators.userId })
      .from(collaborators)
      .where(inArray(collaborators.databaseId, dbIds))

    const collabMap = new Map<string, string[]>()
    for (const row of allCollabs) {
      const list = collabMap.get(row.databaseId) ?? []
      list.push(row.userId)
      collabMap.set(row.databaseId, list)
    }

    const enriched = all.map((d) => ({
      ...d,
      ownerId: d.userid,
      collaboratorIds: collabMap.get(d.id) ?? [],
    }))
    return c.json(enriched)
  } catch (err) {
    console.error('[listDatabases]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

export async function getDatabase(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParam = c.req.param('id')

    const idParsed = uuidSchema.safeParse(idParam)
    if (!idParsed.success) {
      return c.json({ error: 'Invalid id format' }, 400)
    }

    if (!(await userHasAccess(idParsed.data, userId, 'viewer'))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const result = await db
      .select()
      .from(databases)
      .where(eq(databases.id, idParsed.data))
      .limit(1)

    if (result.length === 0) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json(result[0])
  } catch (err) {
    console.error('[getDatabase]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

export async function createDatabase(c: Context) {
  try {
    const userId = c.get('user').sub as string

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = createSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error}, 400)
    }

    // Plan gate: free plan has a hard project cap.
    const features = await getUserPlanFeatures(userId)
    if (Number.isFinite(features.projectLimit)) {
      const owned = await db
        .select({ id: databases.id })
        .from(databases)
        .where(eq(databases.userid, userId))
      if (owned.length >= features.projectLimit) {
        return c.json({
          error: 'project_limit_reached',
          message: `Your ${features.plan} plan allows ${features.projectLimit} projects. Upgrade to add more.`,
          plan: features.plan,
          limit: features.projectLimit,
        }, 402)
      }
    }

    const result = await db
      .insert(databases)
      .values({
        id: crypto.randomUUID(),
        userid: userId,
        databaseName: parsed.data.databaseName,
        databaseType: parsed.data.databaseType,
        color: parsed.data.color,
        icon: parsed.data.icon,
        starred: parsed.data.starred,
      })
      .returning()

    const resultSchema = await db
          .insert(schemas)
          .values({
            id: crypto.randomUUID(),
            databaseid: result[0].id,
            dbmlJson: {},
          })

    return c.json(result[0], 201)
  } catch (err) {
    console.error('[createDatabase]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

export async function updateDatabase(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParam = c.req.param('id')

    const idParsed = uuidSchema.safeParse(idParam)
    if (!idParsed.success) {
      return c.json({ error: 'Invalid id format' }, 400)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = updateSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400)
    }

    const existing = await db
      .select()
      .from(databases)
      .where(and(eq(databases.id, idParsed.data), eq(databases.userid, userId)))
      .limit(1)

    if (existing.length === 0) {
      return c.json({ error: 'Not found' }, 404)
    }

    const result = await db
      .update(databases)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(databases.id, idParsed.data), eq(databases.userid, userId)))
      .returning()

    return c.json(result[0])
  } catch (err) {
    console.error('[updateDatabase]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

export async function deleteDatabase(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParam = c.req.param('id')

    const idParsed = uuidSchema.safeParse(idParam)
    if (!idParsed.success) {
      return c.json({ error: 'Invalid id format' }, 400)
    }

    const existing = await db
      .select()
      .from(databases)
      .where(and(eq(databases.id, idParsed.data), eq(databases.userid, userId)))
      .limit(1)

    if (existing.length === 0) {
      return c.json({ error: 'Not found' }, 404)
    }

    await db
      .delete(databases)
      .where(and(eq(databases.id, idParsed.data), eq(databases.userid, userId)))

    return c.json({ message: 'Deleted successfully' })
  } catch (err) {
    console.error('[deleteDatabase]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
