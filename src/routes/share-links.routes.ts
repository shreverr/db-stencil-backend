import { Hono } from 'hono'
import { supabaseAuth } from '../middleware/middleware'
import {
  acceptShareLink,
  revokeShareLink,
} from '../controllers/collaborators.controller'

const shareLinksRoutes = new Hono()

shareLinksRoutes.use('/*', supabaseAuth)

shareLinksRoutes.post('/:token/accept', acceptShareLink)
shareLinksRoutes.delete('/:token', revokeShareLink)

export default shareLinksRoutes
