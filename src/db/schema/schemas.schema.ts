import { relations } from 'drizzle-orm';
import * as p from 'drizzle-orm/pg-core';
import { databases } from './databases.schema';

export const schemas = p.pgTable("schemas", {
  id: p.uuid().primaryKey(),
  createdAt: p.timestamp().notNull().defaultNow(),
  updatedAt: p.timestamp().notNull().defaultNow(),

  databaseid: p.uuid()
    .notNull()
    .references(() => databases.id, { onDelete: "cascade" }),

  dbmlJson: p.json().notNull(),
});

export const schemasRelations = relations(schemas, ({ one }) => ({
  database: one(databases, {
    fields: [schemas.databaseid],
    references: [databases.id],
  }),
}));