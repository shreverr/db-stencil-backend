import { Hono } from 'hono'
import { getPublicSchema } from '../controllers/public-share.controller'

// No auth middleware here — these endpoints are intentionally open.
const publicRoutes = new Hono()

publicRoutes.get('/schemas/:token', getPublicSchema)

export default publicRoutes
