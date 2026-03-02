import { Hono } from 'hono'
import { env } from './config/env'

const app = new Hono()

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: `Service is healthy running on port ${env.PORT}`
  })
})

export default {
  fetch: app.fetch,
  port: env.PORT,
}
