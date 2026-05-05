import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'
import { lookupUserByEmail, getUserProfiles } from '../../controllers/users.controller'

const usersRoutes = new Hono()

usersRoutes.use('/*', supabaseAuth)

usersRoutes.get('/lookup', lookupUserByEmail)
usersRoutes.post('/profiles', getUserProfiles)

export default usersRoutes
