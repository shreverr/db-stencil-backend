import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DB_URI: z.string().nonempty(),
  SUPABASE_URL: z.string().nonempty(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().nonempty(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error)
  process.exit(1)
}

export const env = parsed.data
  