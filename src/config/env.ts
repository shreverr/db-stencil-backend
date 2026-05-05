import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DB_URI: z.string().nonempty(),
  SUPABASE_URL: z.string().nonempty(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().nonempty(),
  CURL_TO: z.string().nonempty(),
  FRONTEND_URL: z.string().nonempty().default('http://localhost:3000'),

  // ── Dodo Payments ─────────────────────────────────────────────────────
  DODO_API_KEY: z.string().optional(),
  DODO_API_URL: z.string().default('https://test.dodopayments.com'),
  DODO_WEBHOOK_SECRET: z.string().optional(),
  // Product ids set in the Dodo dashboard, mirrored here so the checkout
  // endpoint can map our internal variant ids → Dodo products.
  DODO_PRODUCT_PRO_MONTHLY: z.string().optional(),
  DODO_PRODUCT_PRO_ANNUAL: z.string().optional(),
  DODO_PRODUCT_LIMITLESS: z.string().optional(),
  DODO_PRODUCT_TOPUP_SMALL: z.string().optional(),
  DODO_PRODUCT_TOPUP_MEDIUM: z.string().optional(),
  DODO_PRODUCT_TOPUP_LARGE: z.string().optional(),

  // ── AI (OpenAI or any OpenAI-compatible gateway) ──────────────────────
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENROUTER_REFERER: z.string().default('http://localhost:3000'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error)
  process.exit(1)
}

export const env = parsed.data
  