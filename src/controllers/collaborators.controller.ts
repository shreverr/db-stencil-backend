import { Context } from 'hono'
import { z } from 'zod'
import { and, eq, isNull, or, gt, desc } from 'drizzle-orm'
import { db } from '../config/database'
import { collaborators, shareLinks, databaseInvites } from '../db/schema/collaborators.schema'
import { databases } from '../db/schema/databases.schema'
import { getDatabaseRole, userHasAccess } from '../lib/access'
import { supabase } from '../config/supabase'
import { env } from '../config/env'
import { getUserPlanFeatures } from '../lib/billing'

const uuidSchema = z.string().uuid('Invalid id format')

function newToken(): string {
  // URL-safe random token, ~22 chars
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Collaborators ─────────────────────────────────────────────────────────────

export async function listCollaborators(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    if (!(await userHasAccess(idParsed.data, userId, 'viewer'))) {
      return c.json({ error: 'Not found' }, 404)
    }

    // Owner row first, then explicit collaborators
    const dbRow = await db
      .select({ ownerId: databases.userid })
      .from(databases)
      .where(eq(databases.id, idParsed.data))
      .limit(1)
    const collabs = await db
      .select({ userId: collaborators.userId, role: collaborators.role, addedAt: collaborators.addedAt })
      .from(collaborators)
      .where(eq(collaborators.databaseId, idParsed.data))

    return c.json({
      owner: dbRow[0]?.ownerId ?? null,
      collaborators: collabs,
    })
  } catch (err) {
    console.error('[listCollaborators]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

const removeCollaboratorSchema = z.object({ userId: uuidSchema })

export async function removeCollaborator(c: Context) {
  try {
    const callerId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    const role = await getDatabaseRole(idParsed.data, callerId)
    if (role !== 'owner') return c.json({ error: 'Forbidden' }, 403)

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const parsed = removeCollaboratorSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation failed' }, 400)

    await db
      .delete(collaborators)
      .where(and(eq(collaborators.databaseId, idParsed.data), eq(collaborators.userId, parsed.data.userId)))

    return c.json({ ok: true })
  } catch (err) {
    console.error('[removeCollaborator]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

/**
 * DELETE /api/v1/databases/:id/collaborators/me
 * Self-leave: a non-owner collaborator removes themselves from the database.
 * Owners can't leave their own database (they'd have to transfer or delete).
 */
export async function leaveDatabase(c: Context) {
  try {
    const callerId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    const role = await getDatabaseRole(idParsed.data, callerId)
    if (role === null) return c.json({ error: 'Not found' }, 404)
    if (role === 'owner') return c.json({ error: 'Owners cannot leave their own database' }, 400)

    await db
      .delete(collaborators)
      .where(and(eq(collaborators.databaseId, idParsed.data), eq(collaborators.userId, callerId)))

    return c.json({ ok: true })
  } catch (err) {
    console.error('[leaveDatabase]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

// ── Share links ───────────────────────────────────────────────────────────────

const createLinkSchema = z.object({
  role: z.enum(['editor', 'viewer']).default('editor'),
  expiresInHours: z.number().int().positive().max(24 * 30).optional(),
  isPublic: z.boolean().default(false),
})

export async function createShareLink(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    const role = await getDatabaseRole(idParsed.data, userId)
    if (role !== 'owner' && role !== 'editor') return c.json({ error: 'Forbidden' }, 403)

    let body: unknown = {}
    try { body = await c.req.json() } catch { /* allow empty */ }
    const parsed = createLinkSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation failed' }, 400)

    // Public links are always viewer-only.
    const linkRole = parsed.data.isPublic ? 'viewer' : parsed.data.role
    const isPublic = parsed.data.isPublic

    // Reuse an existing active link with the same (role, isPublic) to avoid duplicates.
    const now = new Date()
    const [existing] = await db
      .select()
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.databaseId, idParsed.data),
          eq(shareLinks.role, linkRole),
          eq(shareLinks.isPublic, isPublic),
          isNull(shareLinks.revokedAt),
          or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now))
        )
      )
      .orderBy(desc(shareLinks.createdAt))
      .limit(1)
    if (existing) return c.json(existing)

    const token = newToken()
    const expiresAt = parsed.data.expiresInHours
      ? new Date(Date.now() + parsed.data.expiresInHours * 3600 * 1000)
      : null

    const [row] = await db
      .insert(shareLinks)
      .values({
        token,
        databaseId: idParsed.data,
        role: linkRole,
        isPublic,
        createdBy: userId,
        expiresAt: expiresAt ?? undefined,
      })
      .returning()

    return c.json(row)
  } catch (err) {
    console.error('[createShareLink]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

// ── Email invites ─────────────────────────────────────────────────────────────

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email')
  .max(254)

const createInviteSchema = z.object({
  email: emailSchema,
  role: z.enum(['editor', 'viewer']).default('editor'),
})

export async function createInvite(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    const role = await getDatabaseRole(idParsed.data, userId)
    if (role !== 'owner' && role !== 'editor') return c.json({ error: 'Forbidden' }, 403)

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const parsed = createInviteSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' }, 400)
    }

    // Don't allow inviting yourself.
    const callerEmail = (c.get('user').email as string | undefined)?.toLowerCase()
    if (callerEmail && callerEmail === parsed.data.email) {
      return c.json({ error: "You can't invite yourself." }, 400)
    }

    // Plan gate: editor invites are paid-only. Free users can still share
    // viewer-role + public links.
    if (parsed.data.role === 'editor') {
      const features = await getUserPlanFeatures(userId)
      if (!features.editorCollab) {
        return c.json({
          error: 'editor_invite_requires_upgrade',
          message: `Inviting editors requires a Pro or Enterprise plan. You can still invite viewers or share a public link.`,
          plan: features.plan,
        }, 402)
      }
    }

    // Upsert: if an unclaimed invite already exists, refresh role.
    const [row] = await db
      .insert(databaseInvites)
      .values({
        databaseId: idParsed.data,
        email: parsed.data.email,
        role: parsed.data.role,
        invitedBy: userId,
      })
      .onConflictDoUpdate({
        target: [databaseInvites.databaseId, databaseInvites.email],
        set: {
          role: parsed.data.role,
          invitedBy: userId,
          invitedAt: new Date(),
          claimedAt: null,
          claimedByUserId: null,
        },
      })
      .returning()

    // Email goes out through the SMTP configured in Supabase Auth → SMTP Settings.
    // The recipient lands on /workspace/<id> after sign-in; our claimInvites
    // flow auto-grants access from the pending row above.
    const emailResult = await sendInviteEmail({
      email: parsed.data.email,
      databaseId: idParsed.data,
    })

    return c.json({ invite: row, emailResult }, 201)
  } catch (err) {
    console.error('[createInvite]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

interface InviteEmailResult {
  sent: boolean
  alreadyExists: boolean
  message: string
}

/**
 * Sends the invite email via Supabase auth (which routes through whatever SMTP
 * the project has configured under Auth → SMTP Settings).
 *
 * - New email → `inviteUserByEmail` creates an auth user and sends the "Invite"
 *   template, redirecting to the project after sign-up.
 * - Existing email → falls back to a magic-link OTP so they can hop into the
 *   project without re-authenticating.
 *
 * Either way, our `claimInvites` flow auto-grants access on first sign-in.
 */
async function sendInviteEmail(args: {
  email: string
  databaseId: string
}): Promise<InviteEmailResult> {
  const redirectTo = `${env.FRONTEND_URL}/workspace/${args.databaseId}`
  try {
    const { error } = await supabase.auth.admin.inviteUserByEmail(args.email, {
      redirectTo,
    })
    if (!error) {
      return { sent: true, alreadyExists: false, message: 'Invite email sent.' }
    }
    const msg = (error.message ?? '').toLowerCase()
    const status = (error as { status?: number }).status
    const alreadyExists =
      msg.includes('already') ||
      msg.includes('registered') ||
      msg.includes('exists') ||
      status === 422

    if (alreadyExists) {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: args.email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      })
      if (!otpError) {
        return {
          sent: true,
          alreadyExists: true,
          message: 'User already had an account — sent them a sign-in link.',
        }
      }
      console.error('[sendInviteEmail] otp fallback failed', otpError)
      return {
        sent: false,
        alreadyExists: true,
        message:
          'User already has an account. They will see this project the next time they sign in.',
      }
    }

    console.error('[sendInviteEmail] inviteUserByEmail error', error)
    return { sent: false, alreadyExists: false, message: error.message ?? 'Could not send email.' }
  } catch (err) {
    console.error('[sendInviteEmail] threw', err)
    return { sent: false, alreadyExists: false, message: 'Email service error.' }
  }
}

export async function listInvites(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    const role = await getDatabaseRole(idParsed.data, userId)
    if (role !== 'owner' && role !== 'editor') return c.json({ error: 'Forbidden' }, 403)

    const rows = await db
      .select()
      .from(databaseInvites)
      .where(and(eq(databaseInvites.databaseId, idParsed.data), isNull(databaseInvites.claimedAt)))
      .orderBy(desc(databaseInvites.invitedAt))

    return c.json(rows)
  } catch (err) {
    console.error('[listInvites]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

const cancelInviteSchema = z.object({ email: emailSchema })

export async function cancelInvite(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    const role = await getDatabaseRole(idParsed.data, userId)
    if (role !== 'owner' && role !== 'editor') return c.json({ error: 'Forbidden' }, 403)

    let body: unknown
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const parsed = cancelInviteSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'Validation failed' }, 400)

    await db
      .delete(databaseInvites)
      .where(
        and(
          eq(databaseInvites.databaseId, idParsed.data),
          eq(databaseInvites.email, parsed.data.email),
          isNull(databaseInvites.claimedAt)
        )
      )

    return c.json({ ok: true })
  } catch (err) {
    console.error('[cancelInvite]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

/**
 * GET /api/v1/invites/mine
 * Returns pending invites addressed to the caller's email, enriched with the
 * project's display name + color so the notifications panel can render a
 * meaningful card.
 */
export async function listMyInvites(c: Context) {
  try {
    const email = (c.get('user').email as string | undefined)?.toLowerCase()
    if (!email) return c.json([])

    const rows = await db
      .select({
        databaseId: databaseInvites.databaseId,
        email: databaseInvites.email,
        role: databaseInvites.role,
        invitedBy: databaseInvites.invitedBy,
        invitedAt: databaseInvites.invitedAt,
        databaseName: databases.databaseName,
        databaseColor: databases.color,
        ownerId: databases.userid,
      })
      .from(databaseInvites)
      .innerJoin(databases, eq(databases.id, databaseInvites.databaseId))
      .where(and(eq(databaseInvites.email, email), isNull(databaseInvites.claimedAt)))
      .orderBy(desc(databaseInvites.invitedAt))

    return c.json(rows)
  } catch (err) {
    console.error('[listMyInvites]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

/**
 * POST /api/v1/invites/:databaseId/accept
 * Claims a single pending invite for the caller, granting collaborator access.
 */
export async function acceptInvite(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const email = (c.get('user').email as string | undefined)?.toLowerCase()
    if (!email) return c.json({ error: 'No email on session' }, 400)

    const idParsed = uuidSchema.safeParse(c.req.param('databaseId'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    const [inv] = await db
      .select()
      .from(databaseInvites)
      .where(and(
        eq(databaseInvites.databaseId, idParsed.data),
        eq(databaseInvites.email, email),
        isNull(databaseInvites.claimedAt),
      ))
      .limit(1)
    if (!inv) return c.json({ error: 'Invite not found' }, 404)

    const current = await getDatabaseRole(inv.databaseId, userId)
    if (current !== 'owner') {
      if (!current) {
        await db.insert(collaborators).values({
          databaseId: inv.databaseId,
          userId,
          role: inv.role,
          addedBy: inv.invitedBy,
        })
      } else if (current === 'viewer' && inv.role === 'editor') {
        await db
          .update(collaborators)
          .set({ role: 'editor' })
          .where(and(eq(collaborators.databaseId, inv.databaseId), eq(collaborators.userId, userId)))
      }
    }
    await db
      .update(databaseInvites)
      .set({ claimedAt: new Date(), claimedByUserId: userId })
      .where(and(eq(databaseInvites.databaseId, inv.databaseId), eq(databaseInvites.email, email)))

    return c.json({ ok: true, databaseId: inv.databaseId, role: inv.role })
  } catch (err) {
    console.error('[acceptInvite]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

/**
 * POST /api/v1/invites/:databaseId/decline
 * Removes a pending invite without granting access. Caller must be the
 * recipient.
 */
export async function declineInvite(c: Context) {
  try {
    const email = (c.get('user').email as string | undefined)?.toLowerCase()
    if (!email) return c.json({ error: 'No email on session' }, 400)

    const idParsed = uuidSchema.safeParse(c.req.param('databaseId'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    await db
      .delete(databaseInvites)
      .where(and(
        eq(databaseInvites.databaseId, idParsed.data),
        eq(databaseInvites.email, email),
        isNull(databaseInvites.claimedAt),
      ))

    return c.json({ ok: true })
  } catch (err) {
    console.error('[declineInvite]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

/**
 * Claim every pending invite addressed to the caller's email.
 * Idempotent — safe to call on every login.
 * Returns the count claimed and the affected database ids.
 */
export async function claimInvites(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const email = (c.get('user').email as string | undefined)?.toLowerCase()
    if (!email) return c.json({ claimed: 0, databaseIds: [] })

    const pending = await db
      .select()
      .from(databaseInvites)
      .where(and(eq(databaseInvites.email, email), isNull(databaseInvites.claimedAt)))

    if (pending.length === 0) return c.json({ claimed: 0, databaseIds: [] })

    const now = new Date()
    const claimedDbIds: string[] = []

    for (const inv of pending) {
      // Skip if caller is already the owner.
      const current = await getDatabaseRole(inv.databaseId, userId)
      if (current !== 'owner') {
        if (!current) {
          await db.insert(collaborators).values({
            databaseId: inv.databaseId,
            userId,
            role: inv.role,
            addedBy: inv.invitedBy,
          })
        } else if (current === 'viewer' && inv.role === 'editor') {
          await db
            .update(collaborators)
            .set({ role: 'editor' })
            .where(and(eq(collaborators.databaseId, inv.databaseId), eq(collaborators.userId, userId)))
        }
      }
      await db
        .update(databaseInvites)
        .set({ claimedAt: now, claimedByUserId: userId })
        .where(and(eq(databaseInvites.databaseId, inv.databaseId), eq(databaseInvites.email, email)))
      claimedDbIds.push(inv.databaseId)
    }

    return c.json({ claimed: claimedDbIds.length, databaseIds: claimedDbIds })
  } catch (err) {
    console.error('[claimInvites]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

export async function listShareLinks(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const idParsed = uuidSchema.safeParse(c.req.param('id'))
    if (!idParsed.success) return c.json({ error: 'Invalid id format' }, 400)

    const role = await getDatabaseRole(idParsed.data, userId)
    if (role !== 'owner' && role !== 'editor') return c.json({ error: 'Forbidden' }, 403)

    const rows = await db
      .select()
      .from(shareLinks)
      .where(and(eq(shareLinks.databaseId, idParsed.data), isNull(shareLinks.revokedAt)))

    return c.json(rows)
  } catch (err) {
    console.error('[listShareLinks]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

export async function revokeShareLink(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const token = c.req.param('token') ?? ''
    if (!token) return c.json({ error: 'Token required' }, 400)

    const [row] = await db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.token, token))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const role = await getDatabaseRole(row.databaseId, userId)
    if (role !== 'owner' && role !== 'editor') return c.json({ error: 'Forbidden' }, 403)

    await db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(eq(shareLinks.token, token))

    return c.json({ ok: true })
  } catch (err) {
    console.error('[revokeShareLink]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}

export async function acceptShareLink(c: Context) {
  try {
    const userId = c.get('user').sub as string
    const token = c.req.param('token') ?? ''
    if (!token) return c.json({ error: 'Token required' }, 400)

    const now = new Date()
    const [row] = await db
      .select()
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.token, token),
          isNull(shareLinks.revokedAt),
          or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now))
        )
      )
      .limit(1)
    if (!row) return c.json({ error: 'Invalid or expired link' }, 404)

    // Check existing role; only upgrade if the link grants higher access.
    const current = await getDatabaseRole(row.databaseId, userId)
    if (current === 'owner') {
      return c.json({ databaseId: row.databaseId, role: 'owner' })
    }
    if (!current) {
      await db.insert(collaborators).values({
        databaseId: row.databaseId,
        userId,
        role: row.role,
        addedBy: row.createdBy,
      })
    } else if (current === 'viewer' && row.role === 'editor') {
      await db
        .update(collaborators)
        .set({ role: 'editor' })
        .where(and(eq(collaborators.databaseId, row.databaseId), eq(collaborators.userId, userId)))
    }

    return c.json({ databaseId: row.databaseId, role: current === 'editor' ? 'editor' : row.role })
  } catch (err) {
    console.error('[acceptShareLink]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
