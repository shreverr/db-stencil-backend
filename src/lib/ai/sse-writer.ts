// Thin wrapper over Hono's StreamingApi that writes typed ServerEvents.
// All AI nodes write through this so the wire format is enforced in one
// place. Errors during write (client aborted, connection dropped) are
// swallowed — there's nothing useful to do at that point.

import type { StreamingApi } from "hono/utils/stream"
import type { ServerEvent } from "./wire"

export interface SseWriter {
  write(event: ServerEvent): Promise<void>
  done(finishReason?: string): Promise<void>
  /**
   * True once the underlying stream has been closed (client disconnect,
   * normal end). Nodes can poll this to short-circuit long-running work.
   */
  closed(): boolean
}

export function createSseWriter(s: StreamingApi): SseWriter {
  let isClosed = false
  s.onAbort(() => { isClosed = true })

  const write = async (event: ServerEvent) => {
    if (isClosed) return
    try {
      await s.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      isClosed = true
    }
  }

  return {
    write,
    closed: () => isClosed,
    done: async (finishReason?: string) => {
      await write({ type: "done", finishReason })
    },
  }
}
