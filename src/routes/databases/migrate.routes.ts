import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'
import { previewMigration, pullSchemaFromDb, runMigration, testConnection } from '../../controllers/migrate.controller'

const migrateRoutes = new Hono()
migrateRoutes.use('/*', supabaseAuth)

migrateRoutes.get('/preview', previewMigration)
migrateRoutes.post('/test', testConnection)
migrateRoutes.post('/run', runMigration)
migrateRoutes.post('/pull', pullSchemaFromDb)

export default migrateRoutes
