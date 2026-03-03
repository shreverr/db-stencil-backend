import { pgTable, unique, pgPolicy, bigint, text, timestamp } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const waitlist = pgTable("waitlist", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "waitlist_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 92233720368547758, cache: 1 }),
	email: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("waitlist_email_key").on(table.email),
	pgPolicy("Allow anonymous inserts", { as: "permissive", for: "insert", to: ["anon"], withCheck: sql`true`  }),
]);
