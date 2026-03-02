import { jwtVerify, createRemoteJWKSet } from "jose"
import { Context, Next } from "hono"
import { env } from "../config/env"

const SUPABASE_PROJECT_URL = env.SUPABASE_URL

const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_PROJECT_URL}/auth/v1/keys`)
)

export async function supabaseAuth(c: Context, next: Next) {
  try {
    const authHeader = c.req.header("Authorization")

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    const token = authHeader.replace("Bearer ", "")

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${SUPABASE_PROJECT_URL}/auth/v1`,
      audience: "authenticated",
    })

    // Attach user to context
    c.set("user", payload)

    await next()
  } catch (err) {
    return c.json({ error: "Invalid or expired token" }, 401)
  }
}