// LangGraph state machine for the AI chat turn.
//
// Per-request graph: the controller calls `buildGraph(ctx)` then `.invoke({})`.
// The graph itself only moves a single `_tick` counter through state to
// satisfy LangGraph's schema requirement; the real bookkeeping lives in a
// closure-scoped `RequestContext` so nodes can stream SSE events imperatively
// and mutate accumulators (decisions, dispatched, tally) without fighting
// reducer ergonomics.
//
// Flow (faithful port of the previous hand-rolled loop):
//
//   START → classifyIntent → mainRound
//   mainRound → router:
//     askedClarification          → closeStream
//     narrationLikely (≤1×)       → mainRound (with retry-nag system msg)
//     planSet & stepsRemain       → mainRound (with plan-incomplete-nag)
//     finishReason="tool_calls"   → mainRound (sequential continuation)
//     !planSet & sparseTablesHit  → fanoutColumns
//     otherwise                   → lintRound
//   fanoutColumns → groupingPass → lintRound → closeStream → END

import { StateGraph, Annotation, START, END } from "@langchain/langgraph"
import { aiTools } from "./tools"
import { buildSystemPrompt } from "./system-prompt"
import type { SchemaTable, SchemaEdge, SchemaGroup } from "./types"
import { projectCanvas, lintCanvas, type ProjectedCall } from "./project-canvas"
import { streamLLM, type ChatMsg } from "./llm-stream"
import type { SseWriter } from "./sse-writer"
import type { ServerEvent } from "./wire"

export interface ChatBody {
  messages: ChatMsg[]
  databaseType: string
  tables: SchemaTable[]
  edges: SchemaEdge[]
  groups?: SchemaGroup[]
  model?: string
}

const MAX_ROUNDS = 14
const FANOUT_CONCURRENCY = 6

const AGENTIC_RE =
  /\b(build|create|make|add|delete|remove|rename|fix|clean[ -]?up|audit|refactor|regroup|apply|do it|yes|go ahead|proceed|design|generate|set ?up|setup|model|implement|wire|hook ?up)\b/
const ADVISORY_RE =
  /\b(thoughts|opinion|review|what (could|can|do|should|'?s|is)|any (issues|suggestions|missing)|how (would|should|could) you|is (this|it) (scalable|good|fine|ok))\b/

// ── Scope guard: allowlist approach — only DB/schema messages reach the LLM ──
// Matches any message that references a DB concept, schema-design term, or improvement intent.
const DB_SCOPE_RE =
  /\b(table|column|schema|database|\bdb\b|field|model|relat|foreign.?key|primary.?key|\bpk\b|\bfk\b|index|sql|data.?type|entity|join|constraint|uuid|integer|bigint|boolean|timestamp|jsonb|nullable|unique|erd|saas|crm|auth|api|backend|stencil|design|build|create|add|delete|remove|rename|refactor|audit|group|canvas|workspace|scalable|scale|improve|optimize|enhance|better|upgrade|expand|normalize|denormalize|migrate|relation|structur)\b/i

export interface RequestContext {
  writer: SseWriter
  apiKey: string
  baseUrl: string
  model: string
  abortSignal: AbortSignal

  body: ChatBody
  initialCanvas: { tables: SchemaTable[]; edges: SchemaEdge[]; groups: SchemaGroup[] }

  // Per-turn accumulators (in-place mutation):
  isAgentic: boolean
  decisions: Map<string, string>
  dispatched: ProjectedCall[]
  planSet: boolean
  planSteps: number
  stepsCompleted: number
  tally: { create_table: number; add_column: number; create_relation: number }
  createdTableNames: string[]
  totalToolCalls: number
  nonClarifyToolCalls: number
  finishReason?: string
  askedClarification: boolean
  parallelDone: boolean
  lintDone: boolean
  narrationRetryUsed: boolean
  round: number
  working: ChatMsg[]
  /** Tools count emitted in the last main-round LLM call (for narration detection). */
  lastRoundToolCount: number
  /** Assistant text length emitted in the last main-round LLM call. */
  lastRoundTextLen: number
  /** Reasoning trace length emitted in the last main-round LLM call. Long
   * reasoning + zero tool calls is the "thinking instead of acting" failure
   * mode and counts as narration for retry purposes. */
  lastRoundReasoningLen: number

  /** Refund hook called by closeStream when nonClarifyToolCalls === 0. */
  refundIfNeeded: () => Promise<void>

  /** Set to true by classifyIntent when message is outside DBStencil scope. */
  offTopic: boolean
}

type AccumulatedKeys =
  | "isAgentic" | "decisions" | "dispatched"
  | "planSet" | "planSteps" | "stepsCompleted"
  | "tally" | "createdTableNames"
  | "totalToolCalls" | "nonClarifyToolCalls"
  | "finishReason" | "askedClarification"
  | "parallelDone" | "lintDone" | "narrationRetryUsed"
  | "round" | "working"
  | "lastRoundToolCount" | "lastRoundTextLen" | "lastRoundReasoningLen"
  | "offTopic"

export function createContext(init: Omit<RequestContext, AccumulatedKeys>): RequestContext {
  return {
    ...init,
    isAgentic: false,
    decisions: new Map(),
    dispatched: [],
    planSet: false,
    planSteps: 0,
    stepsCompleted: 0,
    tally: { create_table: 0, add_column: 0, create_relation: 0 },
    createdTableNames: [],
    totalToolCalls: 0,
    nonClarifyToolCalls: 0,
    askedClarification: false,
    parallelDone: false,
    lintDone: false,
    narrationRetryUsed: false,
    round: 0,
    working: [],
    lastRoundToolCount: 0,
    lastRoundTextLen: 0,
    lastRoundReasoningLen: 0,
    offTopic: false,
  }
}

const StateAnnotation = Annotation.Root({
  // LangGraph requires a non-empty schema. We don't actually use this
  // counter — all real bookkeeping is in `RequestContext`.
  _tick: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
})

type State = typeof StateAnnotation.State

// Build the system message including projected canvas + recorded decisions.
function renderSystem(ctx: RequestContext): string {
  const proj = ctx.dispatched.length === 0
    ? ctx.initialCanvas
    : projectCanvas(ctx.initialCanvas, ctx.dispatched)
  let prompt = buildSystemPrompt({
    databaseType: ctx.body.databaseType,
    tables: proj.tables,
    edges: proj.edges,
    groups: proj.groups,
  })
  if (ctx.decisions.size > 0) {
    const lines = [...ctx.decisions.entries()].map(([k, v]) => `- ${k}: ${v}`).join("\n")
    prompt += `\n\n## Decisions (binding — never contradict)\n${lines}\n`
  }
  return prompt
}

// Process tool calls a node observed: write event-stream side-channels for
// plan/decision/clarify, mutate ctx, and append projection-relevant calls
// to ctx.dispatched. Returns whether `ask_clarification` was emitted.
async function ingestToolCalls(
  ctx: RequestContext,
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): Promise<{ asked: boolean }> {
  let asked = false
  for (const tc of calls) {
    ctx.totalToolCalls++
    if (tc.name === "ask_clarification") {
      asked = true
      const q = typeof tc.args.question === "string" ? tc.args.question : ""
      const opts = Array.isArray(tc.args.options)
        ? tc.args.options.filter((x): x is string => typeof x === "string").slice(0, 5)
        : undefined
      if (q) {
        const ev: Extract<ServerEvent, { type: "clarify" }> = { type: "clarify", question: q }
        if (opts && opts.length > 0) ev.options = opts
        await ctx.writer.write(ev)
      }
      continue
    }
    ctx.nonClarifyToolCalls++

    if (tc.name === "set_plan") {
      const steps = Array.isArray(tc.args.steps)
        ? tc.args.steps.filter((s): s is string => typeof s === "string")
        : []
      if (steps.length > 0) {
        ctx.planSet = true
        ctx.planSteps = steps.length
        await ctx.writer.write({ type: "plan", steps })
      }
      continue
    }
    if (tc.name === "complete_step") {
      const idx = typeof tc.args.index === "number" ? tc.args.index : -1
      const note = typeof tc.args.note === "string" ? tc.args.note : undefined
      if (idx >= 0) {
        ctx.stepsCompleted++
        const ev: Extract<ServerEvent, { type: "step_done" }> = { type: "step_done", index: idx }
        if (note) ev.note = note
        await ctx.writer.write(ev)
      }
      continue
    }
    if (tc.name === "record_decision") {
      const k = typeof tc.args.key === "string" ? tc.args.key.slice(0, 24) : ""
      const v = typeof tc.args.value === "string" ? tc.args.value.slice(0, 32) : ""
      if (k && v) {
        ctx.decisions.set(k, v)
        await ctx.writer.write({ type: "decision", key: k, value: v })
      }
      continue
    }

    // Canvas-modifying call. Track for projection + lint.
    ctx.dispatched.push({ name: tc.name, args: tc.args })
    if (tc.name === "create_table") {
      ctx.tally.create_table++
      if (typeof tc.args.name === "string") ctx.createdTableNames.push(tc.args.name)
    } else if (tc.name === "add_column") ctx.tally.add_column++
    else if (tc.name === "create_relation") ctx.tally.create_relation++
  }
  if (asked) ctx.askedClarification = true
  return { asked }
}

// Null writer — discards all events. Used for silent sub-agent calls
// (e.g. prompt refinement) that must not stream anything to the client.
const nullWriter: SseWriter = {
  write: async () => {},
  done: async () => {},
  closed: () => false,
}

export function buildGraph(ctx: RequestContext) {
  // ── Nodes ──────────────────────────────────────────────────────────────

  // ── refinePrompt — silent first pass that fixes typos/grammar in the
  // last user message before any scope-checking or schema work begins.
  // Makes a cheap LLM call through a null writer so nothing is streamed.
  const refinePrompt = async (_: State): Promise<Partial<State>> => {
    const msgs = ctx.body.messages
    const lastUserIdx = msgs.reduce<number | undefined>((found, m, i) =>
      m.role === "user" ? i : found, undefined)
    if (lastUserIdx === undefined) return { _tick: 1 }

    const raw = msgs[lastUserIdx].content
    // Skip refinement for very short messages — they're already atomic
    if (raw.trim().split(/\s+/).length <= 3) return { _tick: 1 }

    try {
      const result = await streamLLM({
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        model: ctx.model,
        messages: [
          {
            role: "system",
            content:
              "You are a silent prompt cleaner. Fix typos, spelling errors, and grammar in the user message. " +
              "Keep the EXACT intent — do not add, remove, or reinterpret any request. " +
              "Do not expand scope or infer extra features. " +
              "Return ONLY the corrected message. No explanation, no prefix, no quotes.",
          },
          { role: "user", content: raw },
        ],
        maxTokens: 256,
        reasoningMaxTokens: 64,
        signal: ctx.abortSignal,
        suppressText: true,
        writer: nullWriter,
      })

      const refined = result.assistantText.trim()
      if (refined && refined !== raw) {
        const updated = [...msgs]
        updated[lastUserIdx] = { ...updated[lastUserIdx], content: refined }
        ctx.body.messages = updated
      }
    } catch {
      // Non-fatal — proceed with the original message
    }

    return { _tick: 1 }
  }

  const classifyIntent = async (_: State): Promise<Partial<State>> => {
    const lastMsg = [...ctx.body.messages].reverse().find((m) => m.role === "user")?.content ?? ""
    const last = lastMsg.toLowerCase()
    const wordCount = lastMsg.trim().split(/\s+/).length
    // Short (≤6 word) non-advisory messages are AGENTIC: they're domain names
    // ("restaurant management system"), option selections ("Single location"),
    // or brief commands ("yes", "go ahead"). Without this, domain-name inputs
    // get isAgentic=false → suppressText=false → AI narrates lint/debug text.
    ctx.isAgentic = !ADVISORY_RE.test(last) && (AGENTIC_RE.test(last) || wordCount <= 6)
    ctx.working = [{ role: "system", content: renderSystem(ctx) }, ...ctx.body.messages]

    // Scope gate (allowlist): block anything that isn't clearly about DB/schema design.
    // A message is in-scope if it: contains a DB keyword, contains an action word,
    // OR is ≤ 6 words (short replies like "yes", "ok", option selections like "menus + orders + customers").
    const inScope = DB_SCOPE_RE.test(lastMsg) || AGENTIC_RE.test(last) || wordCount <= 6
    if (!inScope) {
      ctx.offTopic = true
      ctx.finishReason = "stop"
      await ctx.writer.write({
        type: "text",
        delta: "Sorry, I can only help with database schema design. Try asking me to build tables, add columns, or design your schema!",
      })
    }

    return { _tick: 1 }
  }

  const mainRound = async (_: State): Promise<Partial<State>> => {
    ctx.round++
    await ctx.writer.write({ type: "node_start", name: "main" })
    await ctx.writer.write({ type: "round_start", round: ctx.round - 1 })
    // Refresh system prompt with latest projection + decisions.
    ctx.working[0] = { role: "system", content: renderSystem(ctx) }

    const result = await streamLLM({
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      model: ctx.model,
      messages: ctx.working,
      tools: aiTools as unknown as unknown[],
      toolChoice: ctx.isAgentic ? "required" : "auto",
      maxTokens: 8192,
      reasoningMaxTokens: 2048,
      signal: ctx.abortSignal,
      suppressText: ctx.isAgentic,
      writer: ctx.writer,
    })

    if (result.upstreamError) {
      await ctx.writer.write({ type: "error", message: result.upstreamError })
      ctx.finishReason = "error"
      return { _tick: 1 }
    }

    ctx.finishReason = result.finishReason
    ctx.lastRoundToolCount = result.toolCalls.length
    ctx.lastRoundTextLen = result.assistantText.trim().length
    ctx.lastRoundReasoningLen = result.reasoningText.trim().length
    await ingestToolCalls(ctx, result.toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args })))

    // Sequential-continuation thread: append assistant message + synthetic
    // tool results so the next round's working[] is well-formed for OpenAI.
    if (result.toolCalls.length > 0) {
      ctx.working.push({
        role: "assistant",
        content: result.assistantText,
        tool_calls: result.toolCalls.map((t) => ({
          id: t.id,
          type: "function" as const,
          function: { name: t.name, arguments: t.rawArgs || "{}" },
        })),
      })
      for (const t of result.toolCalls) {
        ctx.working.push({ role: "tool", tool_call_id: t.id, content: JSON.stringify({ ok: true }) })
      }
    }
    return { _tick: 1 }
  }

  const fanoutColumns = async (_: State): Promise<Partial<State>> => {
    if (ctx.parallelDone || ctx.createdTableNames.length === 0) return { _tick: 1 }
    ctx.parallelDone = true
    await ctx.writer.write({ type: "node_start", name: "fanout" })
    const tableNames = [...ctx.createdTableNames]
    const tablesList = tableNames.join(", ")

    const fillOne = async (tname: string, i: number) => {
      const result = await streamLLM({
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        model: ctx.model,
        messages: [
          { role: "system", content: renderSystem(ctx) },
          ...ctx.body.messages,
          {
            role: "system",
            content: `PARALLEL COLUMN PASS: emit add_column tool calls ONLY for table "${tname}". 5–10 data columns. Do NOT touch other tables. Tables in canvas: ${tablesList}. id + created_at + updated_at + deleted_at are AUTO-ADDED — do NOT emit those. If "${tname}" has FKs to other tables in that list, also emit create_relation (or rely on auto-link if column is "<target_singular>_id"). Output: tool calls only, no text content. Stream slot: ${i}.`,
          },
        ],
        tools: aiTools as unknown as unknown[],
        toolChoice: "required",
        maxTokens: 4096,
        reasoningMaxTokens: 512,
        signal: ctx.abortSignal,
        suppressText: true,
        writer: ctx.writer,
      })
      await ingestToolCalls(ctx, result.toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args })))
    }

    for (let i = 0; i < tableNames.length; i += FANOUT_CONCURRENCY) {
      const batch = tableNames.slice(i, i + FANOUT_CONCURRENCY)
      await Promise.all(batch.map((t, j) => fillOne(t, i + j)))
    }
    return { _tick: 1 }
  }

  const groupingPass = async (_: State): Promise<Partial<State>> => {
    if (ctx.createdTableNames.length <= 4) return { _tick: 1 }
    await ctx.writer.write({ type: "node_start", name: "grouping" })
    const tablesList = ctx.createdTableNames.join(", ")
    const result = await streamLLM({
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      model: ctx.model,
      messages: [
        { role: "system", content: renderSystem(ctx) },
        ...ctx.body.messages,
        {
          role: "system",
          content: `GROUPING PASS: emit create_group tool calls ONLY. Organize these tables into 2–5 domain groups (2–5 tables each). Tables: ${tablesList}. Group labels Title Case (e.g. "Auth & Users", "Billing", "Catalog"). Tool calls only, no text content.`,
        },
      ],
      tools: aiTools as unknown as unknown[],
      toolChoice: "required",
      maxTokens: 2048,
      reasoningMaxTokens: 512,
      signal: ctx.abortSignal,
      suppressText: true,
      writer: ctx.writer,
    })
    await ingestToolCalls(ctx, result.toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args })))
    return { _tick: 1 }
  }

  const lintRound = async (_: State): Promise<Partial<State>> => {
    if (ctx.lintDone) return { _tick: 1 }
    ctx.lintDone = true
    await ctx.writer.write({ type: "node_start", name: "lint" })
    const createdSet = new Set(ctx.createdTableNames.map((n) => n.toLowerCase()))
    // Detect-only, silent: run the lint check for internal correctness tracking
    // but do NOT forward results to the client SSE stream. Lint output was
    // leaking into the chat UI as text narration; hiding it entirely is cleaner.
    lintCanvas(projectCanvas(ctx.initialCanvas, ctx.dispatched), createdSet)
    return { _tick: 1 }
  }

  const closeStream = async (_: State): Promise<Partial<State>> => {
    await ctx.refundIfNeeded()
    await ctx.writer.done(ctx.finishReason)
    return { _tick: 1 }
  }

  // ── Router ─────────────────────────────────────────────────────────────
  // Reads ctx, optionally pushes nag system messages onto ctx.working, and
  // returns the next node. All routing-relevant state from the most recent
  // mainRound was captured into ctx by the node.
  const mainRouter = (): "mainRound" | "fanoutColumns" | "lintRound" | "closeStream" => {
    if (ctx.askedClarification) return "closeStream"
    if (ctx.finishReason === "error") return "closeStream"

    // Narration retry (one-shot). Trigger: agentic turn produced text or
    // reasoning but ZERO tool calls. The reasoning-only case ("thinking
    // model walked through the whole plan in its head") is just as broken
    // as text-only narration — neither mutates the canvas.
    const narrationLikely =
      ctx.isAgentic &&
      ctx.lastRoundToolCount === 0 &&
      (ctx.lastRoundTextLen > 0 || ctx.lastRoundReasoningLen > 200)
    if (narrationLikely && !ctx.narrationRetryUsed && ctx.round < MAX_ROUNDS) {
      ctx.narrationRetryUsed = true
      ctx.working.push({
        role: "system",
        content: `🚨 PREVIOUS ATTEMPT FAILED. You ${
          ctx.lastRoundTextLen > 0 ? "replied with text" : "spent your reasoning trace planning"
        } but emitted ZERO tool calls. Neither the text channel nor the reasoning channel can modify the canvas — ONLY function calls can. STOP THINKING, START EMITTING. This round: emit the actual \`set_plan\`/\`create_table\`/\`add_column\`/\`create_relation\`/\`create_group\` calls through the function-calling channel. Do NOT write the same plan as text or reasoning again — invoke it.`,
      })
      return "mainRound"
    }

    // Plan-aware incompleteness: keep going until every declared step ticks
    // off. Triggers when the model stopped (finish !== "tool_calls") with
    // unfinished plan steps.
    if (
      ctx.planSet &&
      ctx.stepsCompleted < ctx.planSteps &&
      ctx.round < MAX_ROUNDS &&
      ctx.finishReason !== "tool_calls"
    ) {
      ctx.working.push({
        role: "system",
        content: `PLAN INCOMPLETE: ${ctx.stepsCompleted}/${ctx.planSteps} steps complete. Continue executing the remaining steps now. Emit canvas tools + \`complete_step\` calls. No prose, no early stop.`,
      })
      return "mainRound"
    }

    // Auto-fanout shortcut — ONLY for unplanned turns. When the model
    // declared a plan, we trust the plan; the fanout would steal rounds it
    // needs to execute later steps.
    if (!ctx.planSet && !ctx.parallelDone && ctx.createdTableNames.length >= 2) {
      const colsPerTable = ctx.tally.add_column / ctx.createdTableNames.length
      const colsAreSparse = colsPerTable < 2
      if (colsAreSparse || ctx.finishReason !== "tool_calls") {
        return "fanoutColumns"
      }
    }

    // Sequential continuation: model still emitting tools, looping fine.
    if (ctx.finishReason === "tool_calls" && ctx.round < MAX_ROUNDS) {
      return "mainRound"
    }

    // Incomplete-build nag for non-planned turns.
    if (
      ctx.finishReason !== "tool_calls" &&
      ctx.round < MAX_ROUNDS &&
      ctx.tally.create_table > 0 &&
      (ctx.tally.add_column / Math.max(1, ctx.tally.create_table) < 3 || ctx.tally.add_column === 0)
    ) {
      ctx.working.push({
        role: "system",
        content: `INCOMPLETE: you created ${ctx.tally.create_table} tables but only ${ctx.tally.add_column} columns and ${ctx.tally.create_relation} explicit relations so far. Continue NOW — emit add_column for every data column on every table (5–10 per table), then explicit create_relation for any non-conventional FKs. Tool calls only, no text.`,
      })
      return "mainRound"
    }

    return "lintRound"
  }

  // ── Wire it up ─────────────────────────────────────────────────────────
  return new StateGraph(StateAnnotation)
    .addNode("refinePrompt", refinePrompt)
    .addNode("classifyIntent", classifyIntent)
    .addNode("mainRound", mainRound)
    .addNode("fanoutColumns", fanoutColumns)
    .addNode("groupingPass", groupingPass)
    .addNode("lintRound", lintRound)
    .addNode("closeStream", closeStream)
    .addEdge(START, "refinePrompt")
    .addEdge("refinePrompt", "classifyIntent")
    .addConditionalEdges("classifyIntent", () => ctx.offTopic ? "closeStream" : "mainRound", {
      mainRound: "mainRound",
      closeStream: "closeStream",
    })
    .addConditionalEdges("mainRound", mainRouter, {
      mainRound: "mainRound",
      fanoutColumns: "fanoutColumns",
      lintRound: "lintRound",
      closeStream: "closeStream",
    })
    .addEdge("fanoutColumns", "groupingPass")
    .addEdge("groupingPass", "lintRound")
    .addEdge("lintRound", "closeStream")
    .addEdge("closeStream", END)
    .compile()
}
