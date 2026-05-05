import { Hono } from 'hono'
import { supabaseAuth } from '../middleware/middleware'
import { claimInvites, listMyInvites, acceptInvite, declineInvite } from '../controllers/collaborators.controller'

const invitesRoutes = new Hono()
invitesRoutes.use('/*', supabaseAuth)
invitesRoutes.get('/mine', listMyInvites)
invitesRoutes.post('/:databaseId/accept', acceptInvite)
invitesRoutes.post('/:databaseId/decline', declineInvite)
invitesRoutes.post('/claim', claimInvites)

export default invitesRoutes
