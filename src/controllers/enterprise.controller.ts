import { Context } from 'hono'
import { z } from 'zod'
import { db } from '../config/database'
import { enterpriseLeads } from '../db/schema/enterprise.schema'
import { env } from '../config/env'

const leadSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(160),
  company: z.string().max(160).optional(),
  teamSize: z.string().max(60).optional(),
  message: z.string().min(10).max(2000),
})

/**
 * POST /api/v1/enterprise/contact — accepts leads from the "Talk to us" form.
 * Public endpoint (no auth required) so unauthenticated visitors on the
 * pricing page can submit. If the caller is signed in, we attach their userId.
 */
export async function submitEnterpriseLead(c: Context) {
  let body: unknown
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
  const parsed = leadSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400)

  // Optional: pull userId from auth middleware if present (route is mounted
  // without the gate, but a signed-in caller will have a Bearer token).
  let userId: string | null = null
  try {
    const u = c.get('user') as { sub?: string } | undefined
    if (u?.sub) userId = u.sub
  } catch { /* unauthenticated — fine */ }

  const [row] = await db.insert(enterpriseLeads).values({
    userId,
    name: parsed.data.name,
    email: parsed.data.email,
    company: parsed.data.company ?? null,
    teamSize: parsed.data.teamSize ?? null,
    message: parsed.data.message,
  }).returning()

  // Fire-and-forget email notification. We don't block the response on
  // mail delivery — the lead is already persisted.
  void notifyLead(parsed.data).catch((err) =>
    console.error('[enterprise.contact] notify failed:', (err as Error).message),
  )

  return c.json({ ok: true, id: row?.id })
}

async function notifyLead(lead: z.infer<typeof leadSchema>) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    console.info('[enterprise.contact] SMTP not configured — lead stored only')
    return
  }
  // Lazy-import nodemailer so the dep is only loaded when a lead arrives.
  const nodemailer = await import('nodemailer').catch(() => null)
  if (!nodemailer) {
    console.info('[enterprise.contact] nodemailer not installed — lead stored only')
    return
  }
  const transporter = nodemailer.default.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: (env.SMTP_PORT ?? 587) === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  })
  await transporter.sendMail({
    from: env.SMTP_FROM ?? env.SMTP_USER,
    to: env.ENTERPRISE_LEADS_EMAIL,
    subject: `New Enterprise Lead — ${lead.name}${lead.company ? ` (${lead.company})` : ''}`,
    text: [
      `Name: ${lead.name}`,
      `Email: ${lead.email}`,
      lead.company ? `Company: ${lead.company}` : null,
      lead.teamSize ? `Team size: ${lead.teamSize}` : null,
      '',
      'Message:',
      lead.message,
    ].filter(Boolean).join('\n'),
  })
}
