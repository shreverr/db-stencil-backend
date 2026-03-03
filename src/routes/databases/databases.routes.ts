import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'
import {
  listDatabases,
  getDatabase,
  createDatabase,
  updateDatabase,
  deleteDatabase,
} from '../../controllers/databases.controller'

const databaseRoutes = new Hono()

databaseRoutes.use('/*', supabaseAuth)

databaseRoutes.get('/', listDatabases)
databaseRoutes.get('/:id', getDatabase)
databaseRoutes.post('/', createDatabase)
databaseRoutes.patch('/:id', updateDatabase)
databaseRoutes.delete('/:id', deleteDatabase)

export default databaseRoutes
