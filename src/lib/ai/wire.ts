// Wire format between the AI backend and frontend chat panel.
//
// One SSE channel of typed JSON lines (`data: <json>\n\n`). The frontend
// stream-client parses these and emits typed events to the chat panel.
// Tool calls land atomically (one event = one row); prose and reasoning
// stream token-by-token via `text` and `reasoning` events.
//
// Mirror this union in db-stencil-app/lib/ai/stream-client.ts when changing.

export type ServerEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "round_start"; round: number }
  | { type: "node_start"; name: "main" | "fanout" | "grouping" | "lint" }
  | {
      type: "tool"
      id: string
      name: string
      args: Record<string, unknown>
      status: "ok" | "fail"
      summary: string
    }
  | { type: "plan"; steps: string[] }
  | { type: "step_done"; index: number; note?: string }
  | { type: "decision"; key: string; value: string }
  | { type: "clarify"; question: string; options?: string[] }
  | { type: "lint_failures"; failures: { code: string; message: string }[] }
  | { type: "refunded"; amount: number }
  | { type: "error"; message: string; code?: "insufficient_credits"; balance?: number }
  | { type: "done"; finishReason?: string }
