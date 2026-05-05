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
  DODO_PRODUCT_TOPUP_200: z.string().optional(),

  // Where enterprise contact-form leads get emailed.
  ENTERPRISE_LEADS_EMAIL: z.string().email().default('sudo.aditya@gmail.com'),
  // Optional SMTP config for lead-notification emails. If unset we still
  // store the lead in the DB; just no outbound email.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error)
  process.exit(1)
}

export const env = parsed.data
  