import { Hono } from 'hono'
import { supabaseAuth } from '../../middleware/middleware'

const authRoutes = new Hono()

authRoutes.get("/protected", supabaseAuth, (c) => {
  const user = c.get("user")

  return c.json({
    message: "Authenticated successfully",
    userId: user.sub,
    email: user.email,
  })
})

export default authRoutes 
