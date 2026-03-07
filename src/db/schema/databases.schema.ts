import * as p from 'drizzle-orm/pg-core';

export const databaseType = p.pgEnum("databaseType", ["postgres"]);

export const databases = p.pgTable("databases", {
  id: p.uuid().primaryKey(),
  createdAt: p.timestamp().notNull().defaultNow(),
  updatedAt: p.timestamp().notNull().defaultNow(),
  userid: p.uuid().notNull(),
  databaseName: p.text().notNull(),
  databaseType: databaseType("databaseType").notNull(),
  color: p.text().notNull(),
});
