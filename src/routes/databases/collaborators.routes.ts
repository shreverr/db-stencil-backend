import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'
import {
  listCollaborators,
  removeCollaborator,
  leaveDatabase,
  createShareLink,
  listShareLinks,
  createInvite,
  listInvites,
  cancelInvite,
} from '../../controllers/collaborators.controller'

const collaboratorsRoutes = new Hono()

collaboratorsRoutes.use('/*', supabaseAuth)

collaboratorsRoutes.get('/', listCollaborators)
collaboratorsRoutes.delete('/', removeCollaborator)
collaboratorsRoutes.delete('/me', leaveDatabase)

collaboratorsRoutes.post('/share-links', createShareLink)
collaboratorsRoutes.get('/share-links', listShareLinks)

collaboratorsRoutes.post('/invites', createInvite)
collaboratorsRoutes.get('/invites', listInvites)
collaboratorsRoutes.delete('/invites', cancelInvite)

export default collaboratorsRoutes
