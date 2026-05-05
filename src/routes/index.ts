import { Hono } from 'hono'
import authRoutes from './users/auth.routes'
import onboardRoutes from './users/onboard.routes'
import usersRoutes from './users/users.routes'
import creditsRoutes from './credits.routes'
import billingRoutes from './billing.routes'
import webhooksRoutes from './webhooks.routes'
import databaseRoutes from './databases/databases.routes'
import schemasRoutes from './databases/schemas.routes'
import collaboratorsRoutes from './databases/collaborators.routes'
import migrateRoutes from './databases/migrate.routes'
import shareLinksRoutes from './share-links.routes'
import invitesRoutes from './invites.routes'
import publicRoutes from './public.routes'
import aiRoutes from './ai.routes'

const routes = new Hono()

routes.route('/auth', authRoutes)
routes.route('/onboard', onboardRoutes)
routes.route('/users', usersRoutes)
routes.route('/credits', creditsRoutes)
routes.route('/billing', billingRoutes)
routes.route('/webhooks', webhooksRoutes)
routes.route('/databases/:id/schemas', schemasRoutes)
routes.route('/databases/:id/collaborators', collaboratorsRoutes)
routes.route('/databases/:id/migrate', migrateRoutes)
routes.route('/databases', databaseRoutes)
routes.route('/share-links', shareLinksRoutes)
routes.route('/invites', invitesRoutes)
routes.route('/public', publicRoutes)
routes.route('/ai', aiRoutes)

export default routes
