import { Hono } from 'hono'
import { supabaseAuth } from '../middleware/middleware'
import { chatStream } from '../controllers/ai.controller'

const aiRoutes = new Hono()
aiRoutes.use('/*', supabaseAuth)

aiRoutes.post('/chat', chatStream)

export default aiRoutes
