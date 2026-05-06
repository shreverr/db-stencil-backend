import { Context } from 'hono'
import { stream } from 'hono/streaming'
import { env } from '../config/env'
import { buildGraph, createContext, type ChatBody } from '../lib/ai/graph'
import { createSseWriter } from '../lib/ai/sse-writer'
import { COST_PER_AI_TURN, deductMessages, ensureMessagesRow, grantMessages } from './messages.controller'

/**
 * POST /api/v1/ai/chat
 *
 * Streaming agentic chat. Atomically deducts credits up front, builds a
 * per-request LangGraph state machine, and pipes its SSE event stream to
 * the client. The graph emits a typed `ServerEvent` JSON line per event;
 * see `db-stencil-backend/src/lib/ai/wire.ts`.
 */
export async function chatStream(c: Context) {
  const apiKey = env.OPENAI_API_KEY
  if (!apiKey) return c.json({ error: 'OPENAI_API_KEY not configured' }, 500)

  const userId = c.get('user').sub as string

  const ok = await deductMessages(userId, COST_PER_AI_TURN, 'ai_chat')
  if (ok === null) {
    const row = await ensureMessagesRow(userId)
    return c.json(
      {
        error: 'insufficient_messages',
        message: "You're out of AI messages. Top up to keep generating.",
        balance: row.balance,
        required: COST_PER_AI_TURN,
      },
      402,
    )
  }

  let body: ChatBody
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }

  c.header('Content-Type', 'text/event-stream; charset=utf-8')
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('Connection', 'keep-alive')

  return stream(c, async (s) => {
    const aborted = new AbortController()
    s.onAbort(() => aborted.abort())
    const writer = createSseWriter(s)

    // Refund predicate: a turn that produces zero canvas-modifying calls
    // (clarification-only OR full no-op) shouldn't cost a credit. The
    // graph's closeStream node calls this once before terminating.
    const ctx = createContext({
      writer,
      apiKey,
      baseUrl: env.OPENAI_BASE_URL,
      model: body.model ?? env.OPENAI_MODEL,
      abortSignal: aborted.signal,
      body,
      initialCanvas: {
        tables: body.tables,
        edges: body.edges,
        groups: body.groups ?? [],
      },
      refundIfNeeded: async () => {
        if (ctx.nonClarifyToolCalls > 0) return
        try {
          const newBal = await grantMessages(userId, COST_PER_AI_TURN, 'refund:ai_chat_no_canvas')
          if (newBal !== null) await writer.write({ type: 'refunded', amount: COST_PER_AI_TURN })
        } catch (e) {
          console.error('[ai/chat] refund failed:', (e as Error).message)
        }
      },
    })

    const graph = buildGraph(ctx)

    try {
      // Recursion limit covers up to ~14 mainRound revisits + ancillary
      // nodes. Higher than the legacy MAX_ROUNDS to leave headroom.
      await graph.invoke({ _tick: 0 }, { recursionLimit: 64, signal: aborted.signal })
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      // Recursion-limit blowups are unusual but shouldn't 500 the user —
      // surface as an error event and let closeStream finalize.
      console.error('[ai/chat] graph invoke failed:', msg)
      await writer.write({ type: 'error', message: msg.slice(0, 300) })
      await writer.done('error')
    }
  })
}
