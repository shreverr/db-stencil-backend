import { Context } from 'hono'
import { env } from '../config/env'

interface AdminUser {
  id: string
  email?: string | null
  user_metadata?: Record<string, unknown> | null
  raw_user_meta_data?: Record<string, unknown> | null
}

interface AdminListResponse {
  users?: AdminUser[]
}

interface UserProfile {
  exists: true
  userId: string
  email: string
  displayName: string
  avatarUrl?: string
}

function toProfile(user: AdminUser): UserProfile {
  const meta = (user.user_metadata ?? user.raw_user_meta_data ?? {}) as Record<string, unknown>
  const displayName =
    (meta.full_name as string) ||
    (meta.name as string) ||
    (meta.user_name as string) ||
    (user.email ? user.email.split('@')[0] : 'User')
  const avatarUrl =
    (meta.avatar_url as string) ||
    (meta.picture as string) ||
    undefined
  return {
    exists: true,
    userId: user.id,
    email: user.email ?? '',
    displayName,
    avatarUrl,
  }
}

/**
 * GET /api/v1/users/lookup?email=<email>
 * Looks up a Supabase auth user by email via the GoTrue admin REST API.
 * Returns a minimal profile if found, `{ exists: false }` otherwise.
 */
export async function lookupUserByEmail(c: Context) {
  const raw = (c.req.query('email') ?? '').trim().toLowerCase()
  if (!raw || !raw.includes('@')) {
    return c.json({ exists: false }, 200)
  }
  try {
    // GoTrue's `?email=` query is unreliable across versions — some honor it
    // as a filter, some ignore it and return paginated results. So we always
    // post-filter by exact email. Walk up to MAX_PAGES of 200 users each
    // until we find the target or exhaust the directory.
    const PER_PAGE = 200
    const MAX_PAGES = 10 // 2000 users; bump if user base grows past this
    let user: AdminUser | undefined
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(raw)}&page=${page}&per_page=${PER_PAGE}`
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        },
      })
      if (!res.ok) {
        console.error('[lookupUserByEmail] admin api', res.status, await res.text().catch(() => ''))
        return c.json({ exists: false }, 200)
      }
      const data = (await res.json()) as AdminListResponse | AdminUser
      const list: AdminUser[] = Array.isArray((data as AdminListResponse).users)
        ? (data as AdminListResponse).users!
        : (data as AdminUser).id
          ? [data as AdminUser]
          : []
      if (list.length === 0) break
      const hit = list.find((u) => (u.email ?? '').toLowerCase() === raw)
      if (hit) { user = hit; break }
      if (list.length < PER_PAGE) break
    }
    if (!user) return c.json({ exists: false })
    return c.json(toProfile(user))
  } catch (err) {
    console.error('[lookupUserByEmail]', err)
    return c.json({ exists: false }, 200)
  }
}

/**
 * POST /api/v1/users/profiles  body: { ids: string[] }
 * Returns minimal profiles for the given Supabase auth user ids. Missing /
 * unresolved ids are omitted from the result. Caps fan-out at 100.
 */
export async function getUserProfiles(c: Context) {
  let body: { ids?: unknown }
  try { body = await c.req.json() } catch { return c.json([], 200) }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : []
  if (ids.length === 0) return c.json([])

  const unique = Array.from(new Set(ids)).slice(0, 100)
  const results = await Promise.all(unique.map(async (id) => {
    try {
      const url = `${env.SUPABASE_URL}/auth/v1/admin/users/${id}`
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        },
      })
      if (!res.ok) return null
      const user = (await res.json()) as AdminUser
      return toProfile(user)
    } catch {
      return null
    }
  }))
  return c.json(results.filter((p): p is UserProfile => !!p))
}
