import { Hono } from 'hono'
import { env } from './config/env'
import routes from './routes'
import { connectDB } from './config/database'
import { cors } from 'hono/cors'


const app = new Hono()
connectDB()

app.use('/api/v1/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))
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
