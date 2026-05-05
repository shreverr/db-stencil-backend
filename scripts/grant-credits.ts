/**
 * One-shot: grant credits to a user looked up by email.
 *   bun run scripts/grant-credits.ts sudo.aditya@gmail.com 1000
 */
import 'dotenv/config'
import { db } from '../src/config/database'
import { userCredits, creditLedger } from '../src/db/schema/credits.schema'
import { sql } from 'drizzle-orm'
import { env } from '../src/config/env'

const email = (process.argv[2] ?? '').trim().toLowerCase()
const amount = parseInt(process.argv[3] ?? '1000', 10)

if (!email || !email.includes('@') || !amount || amount <= 0) {
  console.error('Usage: bun run scripts/grant-credits.ts <email> <amount>')
  process.exit(1)
}

async function lookupUserId(email: string): Promise<string | null> {
  const PER_PAGE = 200
  for (let page = 1; page <= 10; page++) {
    const url = `${env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}&page=${page}&per_page=${PER_PAGE}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      },
    })
    if (!res.ok) {
      console.error('admin api', res.status, await res.text().catch(() => ''))
      return null
    }
    const data = await res.json() as { users?: Array<{ id: string; email?: string | null }> }
    const list = data.users ?? []
    if (list.length === 0) return null
    const hit = list.find((u) => (u.email ?? '').toLowerCase() === email)
    if (hit) return hit.id
    if (list.length < PER_PAGE) return null
  }
  return null
}

async function main() {
  const userId = await lookupUserId(email)
  if (!userId) {
    console.error(`No Supabase user found for ${email}`)
    process.exit(2)
  }
  console.log(`Found user ${email} → ${userId}`)

  // Upsert: create row at `amount`, or top up existing row to AT LEAST `amount`.
  await db
    .insert(userCredits)
    .values({ userId, balance: amount })
    .onConflictDoUpdate({
      target: userCredits.userId,
      set: { balance: sql`GREATEST(${userCredits.balance}, ${amount})`, updatedAt: new Date() },
    })

  await db.insert(creditLedger).values({
    userId,
    delta: amount,
    reason: 'manual_grant',
    meta: { email, by: 'script' },
  })

  console.log(`Granted ${amount} credits to ${email}`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
