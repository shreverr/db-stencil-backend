import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'
import type { AppEnv } from '../../types/app'

const authRoutes = new Hono<AppEnv>()

authRoutes.get("/protected", supabaseAuth, (c) => {
  const user = c.get("user")

  return c.json({
    message: "Authenticated successfully",
    userId: user.sub,
    email: user.email,
  })
})

export default authRoutes
