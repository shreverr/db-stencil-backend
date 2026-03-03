import { Hono } from 'hono'
import authRoutes from './users/auth.routes'
import databaseRoutes from './databases/databases.routes'

const routes = new Hono()

routes.route('/auth', authRoutes)
routes.route('/databases', databaseRoutes)

export default routes
