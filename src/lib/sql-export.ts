// Postgres DDL emitter — mirrors app/lib/schema/sql-export.ts.
// Kept on backend so we never trust frontend-generated SQL when running it
// against a user's database.

interface Column {
  id: string
  name: string
  type: string
  primaryKey: boolean
  nullable: boolean
  unique: boolean
  isArray?: boolean
  defaultValue?: string
  checkConstraint?: string
}

interface Index {
  id: string
  name?: string
  columns: string[]
  unique: boolean
  indexType?: string
}

interface Table {
  id: string
  name: string
  columns: Column[]
  indexes?: Index[]
}

interface Edge {
  id: string
  source: string
  sourceColumn: string
  target: string
  targetColumn: string
}

const RESERVED = new Set([
  'user', 'table', 'column', 'index', 'key', 'order', 'group', 'select',
  'where', 'from', 'join', 'left', 'right', 'inner', 'outer', 'on',
  'null', 'true', 'false', 'default', 'check', 'unique', 'primary',
  'foreign', 'references', 'not', 'and', 'or', 'in', 'as', 'by',
])

function quoteIdent(name: string): string {
  return /[^a-z0-9_]/.test(name) || RESERVED.has(name.toLowerCase())
    ? `"${name.replace(/"/g, '""')}"`
    : name
}

function pgType(col: Column): string {
  const base = col.type.toLowerCase()
  return col.isArray ? `${base}[]` : base
}

function columnDDL(col: Column): string {
  const parts: string[] = [`  ${quoteIdent(col.name)} ${pgType(col)}`]
  if (col.primaryKey) parts.push('PRIMARY KEY')
  else {
    if (!col.nullable) parts.push('NOT NULL')
    if (col.unique) parts.push('UNIQUE')
  }
  if (col.defaultValue !== undefined && col.defaultValue !== '') {
    parts.push(`DEFAULT ${col.defaultValue}`)
  }
  if (col.checkConstraint && col.checkConstraint.trim() !== '') {
    parts.push(`CHECK (${col.checkConstraint})`)
  }
  return parts.join(' ')
}

function indexDDL(table: Table, idx: Index): string {
  const colNames = idx.columns
    .map((cid) => table.columns.find((c) => c.id === cid)?.name ?? cid)
    .map(quoteIdent)
    .join(', ')
  const unique = idx.unique ? 'UNIQUE ' : ''
  const using = idx.indexType && idx.indexType !== 'btree' ? ` USING ${idx.indexType.toUpperCase()}` : ''
  const idxName = idx.name ?? `idx_${table.name}_${colNames.replace(/[",\s]/g, '_')}`
  return `CREATE ${unique}INDEX ${quoteIdent(idxName)} ON ${quoteIdent(table.name)}${using} (${colNames});`
}

function foreignKeyDDL(tables: Table[], edge: Edge): string | null {
  const srcTable = tables.find((t) => t.id === edge.source)
  const tgtTable = tables.find((t) => t.id === edge.target)
  const srcCol = srcTable?.columns.find((c) => c.id === edge.sourceColumn)
  const tgtCol = tgtTable?.columns.find((c) => c.id === edge.targetColumn)
  if (!srcTable || !tgtTable || !srcCol || !tgtCol) return null
  const fkName = `fk_${srcTable.name}_${srcCol.name}_${tgtTable.name}`
  return (
    `ALTER TABLE ${quoteIdent(srcTable.name)}\n` +
    `  ADD CONSTRAINT ${quoteIdent(fkName)}\n` +
    `  FOREIGN KEY (${quoteIdent(srcCol.name)})\n` +
    `  REFERENCES ${quoteIdent(tgtTable.name)} (${quoteIdent(tgtCol.name)});`
  )
}

export interface BuildDDLResult {
  /** Single concatenated string for preview / display. */
  text: string
  /** Pre-split statements ready to execute one-by-one inside a transaction. */
  statements: string[]
}

export function buildPostgresDDL(tables: Table[], edges: Edge[]): BuildDDLResult {
  const statements: string[] = []

  for (const table of tables) {
    const cols = table.columns.map(columnDDL)
    statements.push(`CREATE TABLE ${quoteIdent(table.name)} (\n${cols.join(',\n')}\n)`)
  }
  for (const table of tables) {
    for (const idx of table.indexes ?? []) {
      // strip trailing semicolon — pg driver wants one statement per query
      statements.push(indexDDL(table, idx).replace(/;$/, ''))
    }
  }
  // Deduplicate edges by (sourceColumn, targetColumn) pair before generating
  // FK constraints — prevents "constraint already exists" errors from duplicate
  // relations emitted by the AI generation rounds.
  const seenEdgePairs = new Set<string>()
  for (const edge of edges) {
    const pairKey = `${edge.sourceColumn}:${edge.targetColumn}`
    if (seenEdgePairs.has(pairKey)) continue
    seenEdgePairs.add(pairKey)
    const fk = foreignKeyDDL(tables, edge)
    if (fk) statements.push(fk.replace(/;$/, ''))
  }

  const text = statements.map((s) => `${s};`).join('\n\n')
  return { text, statements }
}
