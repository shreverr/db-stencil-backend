import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'
import { onboardUser } from '../../controllers/onboard.controller'

const onboardRoutes = new Hono()
onboardRoutes.use('/*', supabaseAuth)
onboardRoutes.post('/', onboardUser)

export default onboardRoutes
