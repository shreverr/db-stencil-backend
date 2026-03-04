import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'
import {
  listDatabases,
  getDatabase,
  createDatabase,
  updateDatabase,
  deleteDatabase,
} from '../../controllers/databases.controller'
import type { AppEnv } from '../../types/app'

const databaseRoutes = new Hono<AppEnv>()

databaseRoutes.use('/*', supabaseAuth)

databaseRoutes.get('/', listDatabases)
databaseRoutes.get('/:id', getDatabase)
databaseRoutes.post('/', createDatabase)
databaseRoutes.patch('/:id', updateDatabase)
databaseRoutes.delete('/:id', deleteDatabase)

export default databaseRoutes
