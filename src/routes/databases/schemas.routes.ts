import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'
import {
  getSchema,
  updateSchema,
} from '../../controllers/schemas.controller'

const schemasRoutes = new Hono()

schemasRoutes.use('/*', supabaseAuth)

schemasRoutes.get('/', getSchema)
schemasRoutes.patch('/', updateSchema)

export default schemasRoutes
