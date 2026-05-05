// Minimal subset of the canvas schema types the AI route needs to render
// the system-prompt summary. The frontend owns the canonical shape — this
// only mirrors the fields buildSystemPrompt() reads. Anything extra is fine
// as long as those fields are present on the wire payload.

export interface SchemaColumn {
  id: string
  name: string
  type: string
  primaryKey: boolean
  nullable: boolean
  unique: boolean
}

export interface SchemaTable {
  id: string
  name: string
  columns: SchemaColumn[]
}

export interface SchemaEdge {
  source: string
  sourceColumn: string
  target: string
  targetColumn: string
  relationType: "one-to-one" | "one-to-many" | "many-to-one"
}

export interface SchemaGroup {
  label: string
  tableIds: string[]
}
