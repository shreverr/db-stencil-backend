import { Context } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { db } from '../config/database'
import { schemas } from '../db/schema/schemas.schema'
import { databases } from '../db/schema/databases.schema'
import { getDatabaseRole } from '../lib/access'
import { buildPostgresDDL } from '../lib/sql-export'

const uuidSchema = z.string().uuid('Invalid id format')

const connStringSchema = z
  .string()
  .trim()
  .min(10)
  .max(2048)
  .refine((s) => /^postgres(ql)?:\/\//i.test(s), {
    message: 'Only postgres:// connection strings supported in v1',
  })

function hostFromUrl(s: string): string {
  try {
    return new URL(s).host
  } catch {
    return ''
  }
}

/** Connect with tight timeouts so a wrong URL fails fast. */
function connect(connectionString: string) {
  const isLocal = /@localhost|@127\.0\.0\.1|@\[::1\]/i.test(connectionString)
  return postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    // Default to require for non-localhost; respect explicit sslmode in URL otherwise.
    ssl: isLocal ? false : 'require',
    onnotice: () => {},
  })
}

interface DDLPayload {
  text: string
  statements: string[]
}

async function buildDDLForDatabase(databaseId: string): Promise<DDLPayload | null> {
  const [row] = await db
    .select({ dbmlJson: schemas.dbmlJson })
    .from(schemas)
    .where(eq(schemas.databaseid, databaseId))
    .limit(1)
  if (!row) return null
  const j = row.dbmlJson as { tables?: unknown[]; edges?: unknown[] }
  const tables = Array.isArray(j.tables) ? (j.tables as Parameters<typeof buildPostgresDDL>[0]) : []
  const edges = Array.isArray(j.edges) ? (j.edges as Parameters<typeof buildPostgresDDL>[1]) : []
  return buildPostgresDDL(tables, edges)
}

// ── Test connection ─────────────────────────────────────────────────────────

const testSchema = z.object({ connectionString: connStringSchema })

export async function testConnection(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id' }, 400)

    const role = await getDatabaseRole(idParsed.data, userId)
    if (role !== 'owner') return c.json({ error: 'Only owners can run migrations' }, 403)

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    const parsed = testSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' }, 400)
    }

    const sql = connect(parsed.data.connectionString)
    try {
      const [{ version }] = await sql<{ version: string }[]>`SELECT version()`
      const [{ schema_name }] = await sql<{ schema_name: string }[]>`SELECT current_schema() AS schema_name`
      const tables = await sql<{ name: string }[]>`
        SELECT table_name AS name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `
      return c.json({
        ok: true,
        host: hostFromUrl(parsed.data.connectionString),
        schema: schema_name,
        version: version.split(' ').slice(0, 2).join(' '),
        existingTables: tables.map((t) => t.name),
      })
    } finally {
      await sql.end({ timeout: 1 })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Connection failed'
    console.error('[testConnection]', err)
    return c.json({ ok: false, error: msg }, 200)
  }
}

// ── Run migration ───────────────────────────────────────────────────────────

const runSchema = z.object({
  connectionString: connStringSchema,
  /** Confirm overwriting / running against a non-empty schema. */
  force: z.boolean().default(false),
})

export async function runMigration(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id' }, 400)

    const role = await getDatabaseRole(idParsed.data, userId)
    if (role !== 'owner') return c.json({ error: 'Only owners can run migrations' }, 403)

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    const parsed = runSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' }, 400)
    }

    const ddl = await buildDDLForDatabase(idParsed.data)
    if (!ddl || ddl.statements.length === 0) {
      return c.json({ error: 'Schema has no tables to migrate' }, 400)
    }

    // Project metadata for nicer error messages.
    const [proj] = await db
      .select({ name: databases.databaseName })
      .from(databases)
      .where(eq(databases.id, idParsed.data))
      .limit(1)

    const sql = connect(parsed.data.connectionString)
    const start = Date.now()
    try {
      // Pre-flight: bail if target schema already has tables and !force.
      const existing = await sql<{ name: string }[]>`
        SELECT table_name AS name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_type = 'BASE TABLE'
      `
      if (existing.length > 0 && !parsed.data.force) {
        return c.json({
          ok: false,
          code: 'NOT_EMPTY',
          existingTables: existing.map((t) => t.name),
          message: `Target database already has ${existing.length} table${existing.length === 1 ? '' : 's'}.`,
        })
      }

      // Run all statements inside a single transaction. Fail rolls back.
      const ran: string[] = []
      await sql.begin(async (tx) => {
        for (const stmt of ddl.statements) {
          await tx.unsafe(stmt)
          ran.push(stmt)
        }
      })

      return c.json({
        ok: true,
        project: proj?.name ?? null,
        host: hostFromUrl(parsed.data.connectionString),
        statementsRun: ran.length,
        durationMs: Date.now() - start,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Migration failed'
      console.error('[runMigration]', err)
      return c.json({ ok: false, error: msg, durationMs: Date.now() - start }, 200)
    } finally {
      await sql.end({ timeout: 1 })
    }
  } catch (err) {
    console.error('[runMigration:outer]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

// ── Pull (introspect target → DbmlJson) ────────────────────────────────────

const pullSchema = z.object({ connectionString: connStringSchema })

interface PgColumn {
  table_name: string
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: 'YES' | 'NO'
  column_default: string | null
  ordinal_position: number
}

interface PgPK {
  table_name: string
  column_name: string
}

interface PgUnique {
  table_name: string
  column_name: string
}

interface PgFK {
  src_table: string
  src_column: string
  tgt_table: string
  tgt_column: string
  constraint_name: string
}

interface PgIndex {
  table_name: string
  index_name: string
  columns: string[]
  is_unique: boolean
  method: string
}

/** Map a Postgres data_type/udt_name to our short type catalog name. */
function mapPgType(dt: string, udt: string): string {
  const t = dt.toLowerCase()
  if (t === 'array') return udt.replace(/^_/, '') // _int4 → int4
  if (t === 'character varying') return 'varchar'
  if (t === 'character') return 'char'
  if (t === 'timestamp without time zone') return 'timestamp'
  if (t === 'timestamp with time zone') return 'timestamptz'
  if (t === 'time without time zone') return 'time'
  if (t === 'time with time zone') return 'timetz'
  if (t === 'double precision') return 'float8'
  if (t === 'real') return 'float4'
  if (t === 'integer') return 'int'
  if (t === 'bigint') return 'int8'
  if (t === 'smallint') return 'int2'
  if (t === 'boolean') return 'bool'
  if (t === 'user-defined') return udt // enums and custom types
  return t
}

export async function pullSchemaFromDb(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id' }, 400)

    const role = await getDatabaseRole(idParsed.data, userId)
    if (role !== 'owner') return c.json({ error: 'Only owners can pull from a database' }, 403)

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    const parsed = pullSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' }, 400)
    }

    const sql = connect(parsed.data.connectionString)
    try {
      const cols = await sql<PgColumn[]>`
        SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN (
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
          )
        ORDER BY table_name, ordinal_position
      `

      const pks = await sql<PgPK[]>`
        SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.constraint_type = 'PRIMARY KEY'
      `

      const uniques = await sql<PgUnique[]>`
        SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.constraint_type = 'UNIQUE'
      `

      const fks = await sql<PgFK[]>`
        SELECT
          tc.table_name AS src_table,
          kcu.column_name AS src_column,
          ccu.table_name AS tgt_table,
          ccu.column_name AS tgt_column,
          tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.constraint_type = 'FOREIGN KEY'
      `

      const indexes = await sql<PgIndex[]>`
        SELECT
          t.relname AS table_name,
          i.relname AS index_name,
          ARRAY_AGG(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns,
          ix.indisunique AS is_unique,
          am.amname AS method
        FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_am am ON am.oid = i.relam
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE n.nspname = current_schema()
          AND t.relkind = 'r'
          AND NOT ix.indisprimary
        GROUP BY t.relname, i.relname, ix.indisunique, am.amname
      `

      // ── Build DbmlJson ────────────────────────────────────────────────────
      const pkSet = new Set(pks.map((p) => `${p.table_name}::${p.column_name}`))
      const uqSet = new Set(uniques.map((u) => `${u.table_name}::${u.column_name}`))
      const fkSet = new Set(fks.map((f) => `${f.src_table}::${f.src_column}`))

      const tablesByName = new Map<string, {
        id: string
        name: string
        position: { x: number; y: number }
        columns: Array<{
          id: string
          name: string
          type: string
          primaryKey: boolean
          nullable: boolean
          unique: boolean
          isArray?: boolean
          defaultValue?: string
        }>
        indexes?: Array<{
          id: string
          name: string
          columns: string[]
          unique: boolean
          indexType?: string
        }>
      }>()

      // Initialize each table with auto-layout grid positions.
      const tableNames = Array.from(new Set(cols.map((c) => c.table_name)))
      const COLS = 3
      const GAP_X = 360
      const GAP_Y = 320
      tableNames.forEach((name, i) => {
        tablesByName.set(name, {
          id: `t_${name}_${Math.random().toString(36).slice(2, 8)}`,
          name,
          position: { x: 60 + (i % COLS) * GAP_X, y: 60 + Math.floor(i / COLS) * GAP_Y },
          columns: [],
        })
      })

      // Add columns
      const colIdsByKey = new Map<string, string>() // `${table}::${col}` → column id
      for (const c of cols) {
        const t = tablesByName.get(c.table_name)
        if (!t) continue
        const key = `${c.table_name}::${c.column_name}`
        const id = `c_${c.table_name}_${c.column_name}_${Math.random().toString(36).slice(2, 6)}`
        colIdsByKey.set(key, id)
        t.columns.push({
          id,
          name: c.column_name,
          type: mapPgType(c.data_type, c.udt_name),
          primaryKey: pkSet.has(key),
          nullable: c.is_nullable === 'YES',
          unique: uqSet.has(key),
          isArray: c.data_type.toLowerCase() === 'array' || undefined,
          defaultValue: c.column_default ?? undefined,
        })
      }

      // Add indexes
      for (const idx of indexes) {
        const t = tablesByName.get(idx.table_name)
        if (!t) continue
        const colIds = idx.columns
          .map((cn) => colIdsByKey.get(`${idx.table_name}::${cn}`))
          .filter((x): x is string => !!x)
        if (colIds.length === 0) continue
        if (!t.indexes) t.indexes = []
        t.indexes.push({
          id: `i_${idx.index_name}_${Math.random().toString(36).slice(2, 6)}`,
          name: idx.index_name,
          columns: colIds,
          unique: idx.is_unique,
          indexType: idx.method !== 'btree' ? idx.method : undefined,
        })
      }

      // Build edges
      const edges = fks
        .map((f) => {
          const srcTable = tablesByName.get(f.src_table)
          const tgtTable = tablesByName.get(f.tgt_table)
          if (!srcTable || !tgtTable) return null
          const srcId = colIdsByKey.get(`${f.src_table}::${f.src_column}`)
          const tgtId = colIdsByKey.get(`${f.tgt_table}::${f.tgt_column}`)
          if (!srcId || !tgtId) return null
          return {
            id: `e_${f.constraint_name}_${Math.random().toString(36).slice(2, 6)}`,
            source: srcTable.id,
            sourceColumn: srcId,
            target: tgtTable.id,
            targetColumn: tgtId,
            relationType: 'one-to-many' as const,
          }
        })
        .filter((x): x is NonNullable<typeof x> => !!x)

      const dbmlJson = {
        tables: Array.from(tablesByName.values()),
        edges,
        groups: [],
      }

      void fkSet // silence unused if all FKs found
      return c.json({
        ok: true,
        host: hostFromUrl(parsed.data.connectionString),
        tables: tableNames.length,
        columns: cols.length,
        edges: edges.length,
        schema: dbmlJson,
      })
    } finally {
      await sql.end({ timeout: 1 })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Pull failed'
    console.error('[pullSchemaFromDb]', err)
    return c.json({ ok: false, error: msg })
  }
}

// ── Preview SQL (no DB needed) ─────────────────────────────────────────────

export async function previewMigration(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id' }, 400)

    const role = await getDatabaseRole(idParsed.data, userId)
    if (role !== 'owner' && role !== 'editor') return c.json({ error: 'Forbidden' }, 403)

    const ddl = await buildDDLForDatabase(idParsed.data)
    if (!ddl) return c.json({ error: 'Schema not found' }, 404)
    return c.json({ sql: ddl.text, statements: ddl.statements.length })
  } catch (err) {
    console.error('[previewMigration]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
