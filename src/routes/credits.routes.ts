import { Hono } from 'hono'
import { supabaseAuth } from '../middleware/middleware'
import { getMyCredits, deductMyCredits, refundMyCredits } from '../controllers/credits.controller'

const creditsRoutes = new Hono()
creditsRoutes.use('/*', supabaseAuth)

creditsRoutes.get('/', getMyCredits)
creditsRoutes.post('/deduct', deductMyCredits)
creditsRoutes.post('/refund', refundMyCredits)

export default creditsRoutes
