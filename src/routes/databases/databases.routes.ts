import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'

const databaseRoutes = new Hono()

databaseRoutes.get("/", supabaseAuth)
databaseRoutes.get("/:id", supabaseAuth)
databaseRoutes.post("/", supabaseAuth)
databaseRoutes.put("/:id", supabaseAuth)
databaseRoutes.delete("/:id", supabaseAuth)

export default databaseRoutes 
