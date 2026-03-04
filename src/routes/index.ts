import { Hono } from 'hono'
import authRoutes from './users/auth.routes'
import databaseRoutes from './databases/databases.routes'
import schemasRoutes from './databases/schemas.routes'

const routes = new Hono()

routes.route('/auth', authRoutes)
routes.route('/databases/:id/schemas', schemasRoutes)
routes.route('/databases', databaseRoutes)

export default routes
