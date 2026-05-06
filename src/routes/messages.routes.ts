import { Hono } from 'hono'
import { supabaseAuth } from '../middleware/middleware'
import { getMyMessages, deductMyMessages, refundMyMessages } from '../controllers/messages.controller'

const messagesRoutes = new Hono()
messagesRoutes.use('/*', supabaseAuth)

messagesRoutes.get('/', getMyMessages)
messagesRoutes.post('/deduct', deductMyMessages)
messagesRoutes.post('/refund', refundMyMessages)

export default messagesRoutes
