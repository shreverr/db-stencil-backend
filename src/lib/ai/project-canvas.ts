// Server-side mirror of the frontend dispatcher. Walks the tool calls the
// model has emitted this turn and projects them onto the initial canvas
// state, returning the synthetic post-state. Used to:
//
//   1. Refresh the system prompt's "Current canvas" section between rounds
//      so the agent isn't reasoning about a stale snapshot.
//   2. Feed the lint pass at end-of-turn.
//
// We do NOT execute these mutations against any database — the frontend
// dispatcher is still the source of truth on the actual canvas. This is a
// best-effort projection for the model's working memory only.

import type { SchemaTable, SchemaEdge, SchemaGroup, SchemaColumn } from "./types"

export interface ProjectedCall {
  name: string
  args: Record<string, unknown>
}

const TIMESTAMP_COLS = (id: () => string): SchemaColumn[] => ([
  { id: id(), name: "id", type: "uuid", primaryKey: true, nullable: false, unique: true },
  { id: id(), name: "created_at", type: "timestamptz", primaryKey: false, nullable: false, unique: false },
  { id: id(), name: "updated_at", type: "timestamptz", primaryKey: false, nullable: false, unique: false },
  { id: id(), name: "deleted_at", type: "timestamptz", primaryKey: false, nullable: true, unique: false },
])

const lc = (s: string) => s.toLowerCase()
const asStr = (v: unknown) => (typeof v === "string" ? v : undefined)
const asBool = (v: unknown, d = false) => (typeof v === "boolean" ? v : d)

function findTable(tables: SchemaTable[], name: string): SchemaTable | undefined {
  const n = lc(name)
  return tables.find((t) => lc(t.name) === n)
}

function findCol(t: SchemaTable, name: string): SchemaColumn | undefined {
  const n = lc(name)
  return t.columns.find((c) => lc(c.name) === n)
}

export function projectCanvas(
  initial: { tables: SchemaTable[]; edges: SchemaEdge[]; groups: SchemaGroup[] },
  calls: ProjectedCall[],
): { tables: SchemaTable[]; edges: SchemaEdge[]; groups: SchemaGroup[] } {
  // Deep clone so callers don't mutate their inputs.
  const tables: SchemaTable[] = initial.tables.map((t) => ({
    ...t,
    columns: t.columns.map((c) => ({ ...c })),
  }))
  const edges: SchemaEdge[] = initial.edges.map((e) => ({ ...e }))
  const groups: SchemaGroup[] = initial.groups.map((g) => ({ ...g, tableIds: [...g.tableIds] }))

  let counter = 0
  const id = () => `proj_${counter++}_${Date.now().toString(36)}`

  for (const { name, args } of calls) {
    switch (name) {
      case "create_table": {
        const tName = asStr(args.name)
        if (!tName) break
        if (findTable(tables, tName)) break // idempotent skip
        tables.push({
          id: id(),
          name: tName,
          columns: TIMESTAMP_COLS(id),
        })
        break
      }
      case "add_column": {
        const tName = asStr(args.table_name)
        const cName = asStr(args.name)
        const cType = asStr(args.type)
        if (!tName || !cName || !cType) break
        const t = findTable(tables, tName)
        if (!t) break
        if (findCol(t, cName)) break
        t.columns.push({
          id: id(),
          name: cName,
          type: cType,
          primaryKey: asBool(args.primary_key, false),
          nullable: asBool(args.nullable, true),
          unique: asBool(args.unique, false),
        })
        break
      }
      case "update_table": {
        const tName = asStr(args.table_name)
        const newName = asStr(args.new_name)
        if (!tName) break
        const t = findTable(tables, tName)
        if (!t) break
        if (newName) t.name = newName
        break
      }
      case "delete_table": {
        const tName = asStr(args.table_name)
        if (!tName) break
        const idx = tables.findIndex((t) => lc(t.name) === lc(tName))
        if (idx >= 0) {
          const removed = tables.splice(idx, 1)[0]
          // Cascade: remove edges + group memberships.
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i].source === removed.id || edges[i].target === removed.id) edges.splice(i, 1)
          }
          for (const g of groups) {
            g.tableIds = g.tableIds.filter((tid) => tid !== removed.id)
          }
        }
        break
      }
      case "update_column": {
        const tName = asStr(args.table_name)
        const cName = asStr(args.column_name)
        if (!tName || !cName) break
        const t = findTable(tables, tName)
        if (!t) break
        const col = findCol(t, cName)
        if (!col) break
        const newName = asStr(args.new_name); if (newName) col.name = newName
        const cType = asStr(args.type); if (cType) col.type = cType
        if (typeof args.primary_key === "boolean") col.primaryKey = args.primary_key
        if (typeof args.nullable === "boolean") col.nullable = args.nullable
        if (typeof args.unique === "boolean") col.unique = args.unique
        break
      }
      case "delete_column": {
        const tName = asStr(args.table_name)
        const cName = asStr(args.column_name)
        if (!tName || !cName) break
        const t = findTable(tables, tName)
        if (!t) break
        const idx = t.columns.findIndex((c) => lc(c.name) === lc(cName))
        if (idx >= 0) {
          const removed = t.columns.splice(idx, 1)[0]
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i].sourceColumn === removed.id || edges[i].targetColumn === removed.id) edges.splice(i, 1)
          }
        }
        break
      }
      case "create_relation": {
        const sT = asStr(args.source_table)
        const sC = asStr(args.source_column)
        const tT = asStr(args.target_table)
        const tC = asStr(args.target_column)
        const rType = asStr(args.relation_type)
        if (!sT || !sC || !tT || !tC || !rType) break
        const src = findTable(tables, sT); if (!src) break
        const tgt = findTable(tables, tT); if (!tgt) break
        const sCol = findCol(src, sC); if (!sCol) break
        const tCol = findCol(tgt, tC); if (!tCol) break
        // Skip duplicate — same source col → target col pair already exists
        const alreadyExists = edges.some(
          (e) => e.source === src.id && e.sourceColumn === sCol.id &&
                 e.target === tgt.id && e.targetColumn === tCol.id,
        )
        if (alreadyExists) break
        edges.push({
          source: src.id,
          sourceColumn: sCol.id,
          target: tgt.id,
          targetColumn: tCol.id,
          relationType: rType as SchemaEdge["relationType"],
        })
        break
      }
      case "delete_relation": {
        const sT = asStr(args.source_table)
        const sC = asStr(args.source_column)
        const tT = asStr(args.target_table)
        const tC = asStr(args.target_column)
        if (!sT || !sC || !tT || !tC) break
        const src = findTable(tables, sT); if (!src) break
        const tgt = findTable(tables, tT); if (!tgt) break
        const sCol = findCol(src, sC); if (!sCol) break
        const tCol = findCol(tgt, tC); if (!tCol) break
        const idx = edges.findIndex((e) =>
          e.source === src.id && e.sourceColumn === sCol.id &&
          e.target === tgt.id && e.targetColumn === tCol.id)
        if (idx >= 0) edges.splice(idx, 1)
        break
      }
      case "create_group": {
        const label = asStr(args.label)
        if (!label) break
        const rawTables = Array.isArray(args.tables) ? args.tables : []
        const ids: string[] = []
        for (const tn of rawTables) {
          if (typeof tn !== "string") continue
          const t = findTable(tables, tn)
          if (t) ids.push(t.id)
        }
        // Never create a 1-table (or empty) group — auto-drop silently
        if (ids.length < 2) break
        groups.push({ label, tableIds: ids })
        break
      }
      case "delete_group": {
        if (asBool(args.all, false)) {
          groups.length = 0
          break
        }
        const label = asStr(args.label)
        if (!label) break
        const idx = groups.findIndex((g) => lc(g.label) === lc(label))
        if (idx >= 0) groups.splice(idx, 1)
        break
      }
      // No-op tools (don't mutate canvas):
      case "ask_clarification":
      case "set_plan":
      case "complete_step":
      case "record_decision":
        break
    }
  }

  return { tables, edges, groups }
}

// ── Lint ─────────────────────────────────────────────────────────────────────
//
// Server-side checks against the projected canvas. Returns short imperative
// failure messages the model can act on.

const ALLOWED_TYPES = /^(uuid|text|integer|bigint|boolean|timestamptz|jsonb|numeric(\(\d+,\s*\d+\))?)$/i
const FORBIDDEN_TYPE_HINT = /^(varchar|int4|int8|datetime|float|double|serial|bigserial|timestamp)\b/i

const AUTO_COLS = new Set(["id", "created_at", "updated_at", "deleted_at"])

export interface LintFailure {
  code: string
  message: string
}

export function lintCanvas(canvas: { tables: SchemaTable[]; edges: SchemaEdge[]; groups: SchemaGroup[] }, createdNames: Set<string>): LintFailure[] {
  const failures: LintFailure[] = []
  const lcNames = new Set(canvas.tables.map((t) => lc(t.name)))

  for (const t of canvas.tables) {
    const dataCols = t.columns.filter((c) => !AUTO_COLS.has(lc(c.name)))

    // Sparse tables — only flag tables CREATED THIS TURN, so we don't
    // surface user-owned legacy tables.
    if (createdNames.has(lc(t.name)) && dataCols.length < 5) {
      failures.push({
        code: "sparse_columns",
        message: `Table \`${t.name}\` has only ${dataCols.length} data columns. Add more (5–10 per entity).`,
      })
    }

    // Forbidden types
    for (const c of dataCols) {
      if (FORBIDDEN_TYPE_HINT.test(c.type) || (!ALLOWED_TYPES.test(c.type) && c.type)) {
        failures.push({
          code: "bad_type",
          message: `Column \`${t.name}.${c.name}\` has disallowed type \`${c.type}\`. Use uuid|text|integer|bigint|boolean|timestamptz|jsonb|numeric(p,s).`,
        })
      }
    }

    // Missing FK relations on `_id` columns
    for (const c of dataCols) {
      if (lc(c.type) !== "uuid") continue
      if (!/_id$/i.test(c.name)) continue
      if (c.primaryKey) continue
      const base = c.name.replace(/_id$/i, "")
      const candidates = [
        `${base}s`, base, `${base}es`,
        base.endsWith("y") ? `${base.slice(0, -1)}ies` : null,
      ].filter((x): x is string => Boolean(x)).map(lc)
      const autoLink = candidates.some((cand) => lcNames.has(cand))
      if (autoLink) continue
      const explicit = canvas.edges.some((e) => e.source === t.id && t.columns.find((cc) => cc.id === e.sourceColumn)?.name === c.name)
      if (!explicit) {
        failures.push({
          code: "missing_fk",
          message: `Column \`${t.name}.${c.name}\` looks like an FK but no relation exists. Add explicit \`create_relation\` or rename to a target-matching column.`,
        })
      }
    }
  }

  // 1-table groups
  for (const g of canvas.groups) {
    if (g.tableIds.length < 2) {
      failures.push({
        code: "tiny_group",
        message: `Group "${g.label}" has only ${g.tableIds.length} table${g.tableIds.length === 1 ? "" : "s"}. Merge it into a sibling group or delete it.`,
      })
    }
  }

  return failures
}
