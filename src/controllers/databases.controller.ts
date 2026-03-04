import { Context } from 'hono'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { db } from '../config/database'
import { databases } from '../db/schema/databases.schema'
import { schemas } from '../db/schema/schemas.schema'

const createSchema = z.object({
  databaseName: z.string().min(1, 'databaseName is required'),
  databaseType: z.enum(['postgres']),
})

const updateSchema = createSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' }
)

const uuidSchema = z.string().uuid('Invalid id format')

export async function listDatabases(c: Context) {
  try {
    const userId = c.get('user').sub as string

    const result = await db
      .select()
      .from(databases)
      .where(eq(databases.userid, userId))

    return c.json(result)
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

    const result = await db
      .select()
      .from(databases)
      .where(and(eq(databases.id, idParsed.data), eq(databases.userid, userId)))
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

    const result = await db
      .insert(databases)
      .values({
        id: crypto.randomUUID(),
        userid: userId,
        databaseName: parsed.data.databaseName,
        databaseType: parsed.data.databaseType,
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
