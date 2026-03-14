import { Hono } from 'hono'
import { env } from './config/env'
import routes from './routes'
import { connectDB } from './config/database'
import { cors } from 'hono/cors'


const app = new Hono()
connectDB()

const FIVE_MIN = 30 * 1000
const pingTarget = async () => {
  try {
    const res = await fetch(env.CURL_TO)
    console.log(`[ping] ${env.CURL_TO} → ${res.status}`)
  } catch (err) {
    console.error(`[ping] failed to fetch ${env.CURL_TO}:`, err)
  }
}
pingTarget()
setInterval(pingTarget, FIVE_MIN)

app.use('/api/v1/*', cors())
app.route('/api/v1', routes)

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
