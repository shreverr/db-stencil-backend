/**
 * One-shot: grant AI messages to a user looked up by email.
 *   bun run scripts/grant-messages.ts sudo.aditya@gmail.com 250
 */
import 'dotenv/config'
import { db } from '../src/config/database'
import { userMessages, messageLedger } from '../src/db/schema/messages.schema'
import { sql } from 'drizzle-orm'
import { env } from '../src/config/env'

const email = (process.argv[2] ?? '').trim().toLowerCase()
const amount = parseInt(process.argv[3] ?? '250', 10)

if (!email || !email.includes('@') || !amount || amount <= 0) {
  console.error('Usage: bun run scripts/grant-messages.ts <email> <amount>')
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

  // Upsert: create row at `amount`, or top up existing row by `amount`.
  await db
    .insert(userMessages)
    .values({ userId, balance: amount, lifetimeGranted: amount })
    .onConflictDoUpdate({
      target: userMessages.userId,
      set: {
        balance: sql`${userMessages.balance} + ${amount}`,
        lifetimeGranted: sql`${userMessages.lifetimeGranted} + ${amount}`,
        updatedAt: new Date(),
      },
    })

  await db.insert(messageLedger).values({
    userId,
    delta: amount,
    reason: 'manual_grant',
    meta: { email, by: 'script' },
  })

  console.log(`Granted ${amount} messages to ${email}`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
