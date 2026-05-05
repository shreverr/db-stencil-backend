// Raw OpenAI/OpenRouter streaming primitive used inside graph nodes.
//
// We bypass `@langchain/openai` for the LLM call itself because:
//   - LangChain's wrapper strips OpenRouter's non-standard `delta.reasoning`,
//     which we need to forward to the frontend.
//   - We want full control over `tool_choice: "required"`, `parallel_tool_calls`,
//     and the `reasoning: { exclude: false }` knob.
//
// The graph still owns flow control — this is just the LLM call primitive
// nodes invoke. Forwards `text` / `reasoning` events through the writer as
// chunks arrive; emits one `tool` event per tool call after the stream
// closes.

import type { SseWriter } from "./sse-writer"
import type { ServerEvent } from "./wire"

export interface ChatMsg {
  role: "user" | "assistant" | "tool" | "system"
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
}

export interface StreamLLMOptions {
  apiKey: string
  baseUrl: string
  model: string
  messages: ChatMsg[]
  tools?: unknown[]
  /**
   * "required" forces the model to invoke a tool. "auto" lets it choose.
   * Use "required" on agentic/forced sub-passes; "auto" on advisory turns.
   */
  toolChoice?: "auto" | "required"
  maxTokens?: number
  /**
   * Caps reasoning tokens via OpenRouter's `reasoning.max_tokens`. Reasoning
   * models (o-series, Claude thinking, Grok reasoning) will otherwise burn
   * the full max_tokens budget on a chain-of-thought before emitting any
   * tool calls. Set per-node: bigger for planning rounds, smaller for
   * mechanical passes (fanout/grouping/lint).
   */
  reasoningMaxTokens?: number
  /**
   * Forwarded to abort the upstream fetch when the client disconnects.
   */
  signal?: AbortSignal
  /**
   * Suppress writing `text` events for assistant content. Use on agentic
   * turns where any prose is a contract violation (Grok dumping reasoning
   * into content). The text is still returned in the result for narration
   * detection.
   */
  suppressText?: boolean
  /**
   * Optional override for the per-tool summary emitted in the `tool` event.
   * Receives parsed args. Defaults to humanize().
   */
  summarize?: (name: string, args: Record<string, unknown>) => string
  writer: SseWriter
}

export interface AccumulatedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  rawArgs: string
}

export interface StreamLLMResult {
  toolCalls: AccumulatedToolCall[]
  assistantText: string
  reasoningText: string
  finishReason?: string
  /** True if the upstream fetch failed before producing a usable stream. */
  upstreamError?: string
}

interface OpenAIDelta {
  content?: string
  reasoning?: string
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
}

interface OpenAIChunk {
  choices?: Array<{ delta?: OpenAIDelta; finish_reason?: string }>
}

const decoder = new TextDecoder()

// Tool names that have dedicated wire event types (clarify / plan /
// step_done / decision). We skip the generic `tool` event for these so they
// don't render twice on the frontend.
const META_TOOLS = new Set(["ask_clarification", "set_plan", "complete_step", "record_decision"])

export async function streamLLM(opts: StreamLLMOptions): Promise<StreamLLMResult> {
  const result: StreamLLMResult = {
    toolCalls: [],
    assistantText: "",
    reasoningText: "",
  }

  // Some OpenRouter providers reject `tool_choice: "required"` with a 404
  // ("No endpoints found that support the provided 'tool_choice' value").
  // Fall back to "auto" — our prompt already enforces tool emission, so we
  // lose force-tools as a safety rail but keep the request alive.
  const reasoning: Record<string, unknown> = { exclude: false }
  if (typeof opts.reasoningMaxTokens === "number") {
    reasoning.max_tokens = opts.reasoningMaxTokens
  }

  const callOnce = async (toolChoice: "auto" | "required" | undefined): Promise<Response | { error: string }> => {
    try {
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          "X-Title": "DBStencil",
        },
        body: JSON.stringify({
          model: opts.model,
          stream: true,
          messages: opts.messages,
          tools: opts.tools,
          tool_choice: toolChoice ?? "auto",
          parallel_tool_calls: true,
          temperature: 0.2,
          max_tokens: opts.maxTokens ?? 8192,
          reasoning,
        }),
        signal: opts.signal,
      })
      return res
    } catch (e) {
      return { error: `fetch failed: ${(e as Error).message}` }
    }
  }

  let firstAttempt = await callOnce(opts.toolChoice)
  if ("error" in firstAttempt) {
    result.upstreamError = firstAttempt.error
    return result
  }
  let upstream = firstAttempt
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "upstream error")
    const isToolChoiceUnsupported =
      upstream.status === 404 && /tool_choice/i.test(text) && opts.toolChoice === "required"
    if (isToolChoiceUnsupported) {
      console.warn("[ai] provider rejected tool_choice=required; retrying with auto")
      const retry = await callOnce("auto")
      if ("error" in retry) {
        result.upstreamError = retry.error
        return result
      }
      upstream = retry
      if (!upstream.ok || !upstream.body) {
        const t2 = await upstream.text().catch(() => "upstream error")
        result.upstreamError = `HTTP ${upstream.status}: ${t2.slice(0, 300)}`
        return result
      }
    } else {
      result.upstreamError = `HTTP ${upstream.status}: ${text.slice(0, 300)}`
      return result
    }
  }

  // Per-call accumulator keyed by local tool-call index. The shape mirrors
  // OpenAI streaming chunks, where one "function" arrives across many
  // increments (id, name, args delta).
  const toolAcc = new Map<number, { id: string; name: string; rawArgs: string }>()

  const reader = upstream.body.getReader()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl: number
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") continue

      let chunk: OpenAIChunk | null = null
      try { chunk = JSON.parse(data) as OpenAIChunk } catch { continue }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) result.finishReason = choice.finish_reason
      const delta = choice.delta
      if (!delta) continue

      if (delta.reasoning) {
        result.reasoningText += delta.reasoning
        await opts.writer.write({ type: "reasoning", delta: delta.reasoning })
      }

      if (delta.content) {
        result.assistantText += delta.content
        if (!opts.suppressText) {
          await opts.writer.write({ type: "text", delta: delta.content })
        }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let acc = toolAcc.get(tc.index)
          if (!acc) {
            acc = { id: tc.id ?? "", name: "", rawArgs: "" }
            toolAcc.set(tc.index, acc)
          }
          if (tc.id && !acc.id) acc.id = tc.id
          if (tc.function?.name && !acc.name) acc.name = tc.function.name
          if (tc.function?.arguments) acc.rawArgs += tc.function.arguments
        }
      }
    }
  }

  // Finalize tool calls. Two outputs:
  //   1. result.toolCalls — every completed call, used by the graph node
  //      for state tracking (decisions, plan progress, dispatched, etc.).
  //   2. wire `tool` events — only canvas-modifying calls. The four meta
  //      tools (ask_clarification, set_plan, complete_step, record_decision)
  //      have dedicated wire event types emitted by the graph node, so
  //      forwarding them as `tool` events would render them twice.
  const sorted = [...toolAcc.entries()].sort(([a], [b]) => a - b)
  for (const [, acc] of sorted) {
    if (!acc.name || !acc.id) continue
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(acc.rawArgs || "{}") } catch { /* keep empty */ }
    result.toolCalls.push({ id: acc.id, name: acc.name, args, rawArgs: acc.rawArgs })
    if (META_TOOLS.has(acc.name)) continue
    const summary = opts.summarize?.(acc.name, args) ?? humanize(acc.name, args)
    await opts.writer.write({
      type: "tool",
      id: acc.id,
      name: acc.name,
      args,
      status: "ok",
      summary,
    } satisfies Extract<ServerEvent, { type: "tool" }>)
  }

  return result
}

// Humanize a tool name + args into one short imperative phrase. Same vibe
// as the frontend's humanizeAction but server-side.
function humanize(name: string, args: Record<string, unknown>): string {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined)
  const n = (k: string) => (typeof args[k] === "number" ? (args[k] as number) : undefined)
  switch (name) {
    case "create_table":      return `Create table ${s("name") ?? "?"}`
    case "add_column":        return `Add ${s("table_name") ?? "?"}.${s("name") ?? "?"} (${s("type") ?? "?"})`
    case "update_table":      return `Update table ${s("table_name") ?? "?"}`
    case "delete_table":      return `Delete table ${s("table_name") ?? "?"}`
    case "update_column":     return `Update ${s("table_name") ?? "?"}.${s("column_name") ?? "?"}`
    case "delete_column":     return `Delete ${s("table_name") ?? "?"}.${s("column_name") ?? "?"}`
    case "create_relation":   return `Link ${s("source_table") ?? "?"}.${s("source_column") ?? "?"} → ${s("target_table") ?? "?"}.${s("target_column") ?? "?"}`
    case "delete_relation":   return `Unlink ${s("source_table") ?? "?"}.${s("source_column") ?? "?"} → ${s("target_table") ?? "?"}.${s("target_column") ?? "?"}`
    case "create_group":      return `Group "${s("label") ?? "?"}"`
    case "delete_group":      return args.all === true ? "Delete all groups" : `Delete group "${s("label") ?? "?"}"`
    case "set_plan":          return "Set plan"
    case "complete_step": {
      const idx = n("index"); const note = s("note")
      return `Step ${idx !== undefined ? idx + 1 : "?"} done${note ? ` — ${note}` : ""}`
    }
    case "record_decision":   return `Record ${s("key") ?? "?"}: ${s("value") ?? "?"}`
    case "ask_clarification": return s("question") ?? "Ask clarification"
    default:                  return name
  }
}
