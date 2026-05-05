// Tool schema exposed to the OpenAI model. Every tool here maps 1:1 to a
// schema-context mutation the dispatcher fires on the client.

export const aiTools = [
  {
    type: "function",
    function: {
      name: "create_table",
      description: "Create a new table on the canvas. Returns nothing; subsequent calls reference the table by its `name`.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Snake_case table name (e.g. 'users', 'order_items')." },
          color: { type: "string", description: "Optional hex color (e.g. '#3b82f6'). Picks one automatically if omitted." },
          x: { type: "number", description: "Optional canvas x. Auto-laid-out if omitted." },
          y: { type: "number", description: "Optional canvas y. Auto-laid-out if omitted." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_column",
      description: "Add a column to an existing table. Identify the table by `table_name`.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          table_name: { type: "string" },
          name: { type: "string", description: "Column name (snake_case)." },
          type: { type: "string", description: "SQL type — for postgres use 'uuid', 'text', 'varchar', 'int', 'bigint', 'serial', 'bigserial', 'boolean', 'timestamp', 'timestamptz', 'date', 'numeric', 'jsonb', etc." },
          primary_key: { type: "boolean" },
          nullable: { type: "boolean" },
          unique: { type: "boolean" },
          is_array: { type: "boolean" },
          default_value: { type: "string", description: "SQL default expression. Use 'now()' or 'gen_random_uuid()' verbatim for raw SQL." },
          check_constraint: { type: "string" },
        },
        required: ["table_name", "name", "type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_table",
      description: "Rename a table or change its color.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          table_name: { type: "string", description: "Current table name." },
          new_name: { type: "string" },
          color: { type: "string" },
        },
        required: ["table_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_table",
      description: "Remove a table and all its columns + relations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { table_name: { type: "string" } },
        required: ["table_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_column",
      description: "Modify an existing column.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          table_name: { type: "string" },
          column_name: { type: "string" },
          new_name: { type: "string" },
          type: { type: "string" },
          primary_key: { type: "boolean" },
          nullable: { type: "boolean" },
          unique: { type: "boolean" },
          is_array: { type: "boolean" },
          default_value: { type: "string" },
          check_constraint: { type: "string" },
        },
        required: ["table_name", "column_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_column",
      description: "Remove a column from a table.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          table_name: { type: "string" },
          column_name: { type: "string" },
        },
        required: ["table_name", "column_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_relation",
      description: "Create a foreign-key relation between two columns. Both tables and both columns must already exist.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_table: { type: "string" },
          source_column: { type: "string" },
          target_table: { type: "string" },
          target_column: { type: "string" },
          relation_type: { type: "string", enum: ["one-to-one", "one-to-many", "many-to-one"] },
        },
        required: ["source_table", "source_column", "target_table", "target_column", "relation_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_relation",
      description: "Remove a relation by its source/target column ends.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_table: { type: "string" },
          source_column: { type: "string" },
          target_table: { type: "string" },
          target_column: { type: "string" },
        },
        required: ["source_table", "source_column", "target_table", "target_column"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_group",
      description: "Create a visual grouping on the canvas containing the listed tables. Used to organize related tables into a domain (e.g. 'Auth', 'Billing', 'Catalog'). Tables must already exist.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", description: "Group label (Title Case, e.g. 'Auth & Users', 'Order Pipeline')." },
          tables: { type: "array", items: { type: "string" }, description: "Names of tables to include in this group." },
          color: { type: "string", description: "Optional hex/rgba color for the group background." },
        },
        required: ["label", "tables"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_plan",
      description: "Declare the plan for this turn as 3–6 short imperative steps. Emit ONCE near turn start, before any canvas-modifying calls, when the turn will produce ≥5 tool calls. Skip on small turns (single-edit, simple rename). Replaces any previous plan.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          steps: {
            type: "array",
            items: { type: "string" },
            description: "3–6 short imperative steps, ≤6 words each. Example: ['Create core entities', 'Add data columns', 'Wire FK relations', 'Group by domain'].",
          },
        },
        required: ["steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_step",
      description: "Mark one plan step done. Emit immediately after finishing a step's work. Skip if no plan was set.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "number", description: "0-indexed step number from the plan." },
          note: { type: "string", description: "Optional ≤8-word note (e.g. '6 tables created')." },
        },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_decision",
      description: "Record a sticky design decision so it persists across rounds (the server inlines decisions into every subsequent system message). Emit AFTER the user answers an `ask_clarification` and BEFORE building, or whenever you've made a non-obvious design choice the user should see (multi-tenant, soft-delete strategy, RBAC depth, auth method, etc.).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", description: "Short kebab/lowercase key, ≤24 chars (e.g. 'tenancy', 'delete', 'auth')." },
          value: { type: "string", description: "The chosen value, ≤32 chars (e.g. 'multi-tenant', 'soft', 'oauth + sessions')." },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description: "Ask the user one short question when their request is genuinely ambiguous or missing a critical decision (multi-tenant? soft-delete? which entities count as 'users'?). Use this BEFORE making canvas changes you'd otherwise have to guess at. Provide `options` whenever the answer space is small and discrete so the user can click instead of typing. Emit AT MOST ONE per turn, then stop — do not also emit canvas-modifying tools in the same turn.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string", description: "One short question, ≤15 words. Plain English, no tool/jargon." },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional 2–5 short answer choices the user can click. ≤6 words each.",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_group",
      description: "Delete a group from the canvas. Pass `label` to delete one specific group by its label, or set `all: true` to delete all groups. Tables inside the group are NOT affected — only the visual grouping is removed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", description: "Label of the group to delete (case-insensitive)." },
          all: { type: "boolean", description: "Set true to delete every group on the canvas." },
        },
      },
    },
  },
] as const
