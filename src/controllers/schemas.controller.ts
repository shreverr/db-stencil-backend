import { Context } from 'hono'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { db } from '../config/database'
import { schemas } from '../db/schema/schemas.schema'
import { databases } from '../db/schema/databases.schema'

const updateBodySchema = z.object({
  dbmlJson: z.record(z.string(), z.unknown()),
})

const uuidSchema = z.uuid('Invalid id format')

export async function getSchema(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const dbIdParam = c.req.param('id')

    const dbIdParsed = uuidSchema.safeParse(dbIdParam)
    if (!dbIdParsed.success) {
      return c.json({ error: 'Invalid id format' }, 400)
    }

    const result = await db
      .select({ schema: schemas, db: databases })
      .from(schemas)
      .innerJoin(databases, eq(schemas.databaseid, databases.id))
      .where(and(eq(databases.id, dbIdParsed.data), eq(databases.userid, userId)))
      .limit(1)

    if (result.length === 0) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json(result[0].schema)
  } catch (err) {
    console.error('[getSchema]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

export async function updateSchema(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const dbIdParam = c.req.param('id')

    const dbIdParsed = uuidSchema.safeParse(dbIdParam)
    if (!dbIdParsed.success) {
      return c.json({ error: 'Invalid id format' }, 400)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = updateBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: z.flattenError(parsed.error) }, 400)
    }

    const existing = await db
      .select({ schema: schemas })
      .from(schemas)
      .innerJoin(databases, eq(schemas.databaseid, databases.id))
      .where(and(eq(databases.id, dbIdParsed.data), eq(databases.userid, userId)))
      .limit(1)

    if (existing.length === 0) {
      return c.json({ error: 'Not found' }, 404)
    }

    const result = await db
      .update(schemas)
      .set({ dbmlJson: parsed.data.dbmlJson, updatedAt: new Date() })
      .where(eq(schemas.databaseid, dbIdParsed.data))
      .returning()

    return c.json(result[0])
  } catch (err) {
    console.error('[updateSchema]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
