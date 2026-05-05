import { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '../config/database'
import { databases } from '../db/schema/databases.schema'
import { schemas } from '../db/schema/schemas.schema'

type DbmlJson = {
  tables: Array<{
    id: string
    name: string
    color: string
    position: { x: number; y: number }
    columns: Array<{
      id: string
      name: string
      type: string
      primaryKey: boolean
      nullable: boolean
      unique: boolean
      defaultValue?: string
    }>
  }>
  edges: Array<{
    id: string
    source: string
    sourceColumn: string
    target: string
    targetColumn: string
    relationType: string
  }>
}

const sampleSchema: DbmlJson = {
  tables: [
    {
      id: 't_users',
      name: 'users',
      color: '#1892d8',
      position: { x: 60, y: 160 },
      columns: [
        { id: 'c_users_id', name: 'id', type: 'uuid', primaryKey: true, nullable: false, unique: true, defaultValue: 'gen_random_uuid()' },
        { id: 'c_users_email', name: 'email', type: 'varchar(255)', primaryKey: false, nullable: false, unique: true },
        { id: 'c_users_full_name', name: 'full_name', type: 'varchar(255)', primaryKey: false, nullable: true, unique: false },
        { id: 'c_users_avatar_url', name: 'avatar_url', type: 'text', primaryKey: false, nullable: true, unique: false },
        { id: 'c_users_created_at', name: 'created_at', type: 'timestamp', primaryKey: false, nullable: false, unique: false, defaultValue: 'now()' },
      ],
    },
    {
      id: 't_categories',
      name: 'categories',
      color: '#18b888',
      position: { x: 620, y: 50 },
      columns: [
        { id: 'c_cat_id', name: 'id', type: 'uuid', primaryKey: true, nullable: false, unique: true, defaultValue: 'gen_random_uuid()' },
        { id: 'c_cat_name', name: 'name', type: 'varchar(100)', primaryKey: false, nullable: false, unique: true },
        { id: 'c_cat_slug', name: 'slug', type: 'varchar(100)', primaryKey: false, nullable: false, unique: true },
        { id: 'c_cat_description', name: 'description', type: 'text', primaryKey: false, nullable: true, unique: false },
      ],
    },
    {
      id: 't_products',
      name: 'products',
      color: '#7248d8',
      position: { x: 620, y: 310 },
      columns: [
        { id: 'c_prod_id', name: 'id', type: 'uuid', primaryKey: true, nullable: false, unique: true, defaultValue: 'gen_random_uuid()' },
        { id: 'c_prod_name', name: 'name', type: 'varchar(255)', primaryKey: false, nullable: false, unique: false },
        { id: 'c_prod_description', name: 'description', type: 'text', primaryKey: false, nullable: true, unique: false },
        { id: 'c_prod_price', name: 'price', type: 'numeric(10,2)', primaryKey: false, nullable: false, unique: false },
        { id: 'c_prod_stock', name: 'stock', type: 'integer', primaryKey: false, nullable: false, unique: false, defaultValue: '0' },
        { id: 'c_prod_category_id', name: 'category_id', type: 'uuid', primaryKey: false, nullable: true, unique: false },
      ],
    },
    {
      id: 't_orders',
      name: 'orders',
      color: '#d87028',
      position: { x: 60, y: 460 },
      columns: [
        { id: 'c_ord_id', name: 'id', type: 'uuid', primaryKey: true, nullable: false, unique: true, defaultValue: 'gen_random_uuid()' },
        { id: 'c_ord_user_id', name: 'user_id', type: 'uuid', primaryKey: false, nullable: false, unique: false },
        { id: 'c_ord_status', name: 'status', type: 'varchar(50)', primaryKey: false, nullable: false, unique: false, defaultValue: "'pending'" },
        { id: 'c_ord_total', name: 'total', type: 'numeric(10,2)', primaryKey: false, nullable: false, unique: false },
        { id: 'c_ord_created_at', name: 'created_at', type: 'timestamp', primaryKey: false, nullable: false, unique: false, defaultValue: 'now()' },
      ],
    },
    {
      id: 't_order_items',
      name: 'order_items',
      color: '#c83468',
      position: { x: 380, y: 460 },
      columns: [
        { id: 'c_oi_id', name: 'id', type: 'uuid', primaryKey: true, nullable: false, unique: true, defaultValue: 'gen_random_uuid()' },
        { id: 'c_oi_order_id', name: 'order_id', type: 'uuid', primaryKey: false, nullable: false, unique: false },
        { id: 'c_oi_product_id', name: 'product_id', type: 'uuid', primaryKey: false, nullable: false, unique: false },
        { id: 'c_oi_quantity', name: 'quantity', type: 'integer', primaryKey: false, nullable: false, unique: false },
        { id: 'c_oi_unit_price', name: 'unit_price', type: 'numeric(10,2)', primaryKey: false, nullable: false, unique: false },
      ],
    },
  ],
  edges: [
    { id: 'e_cat_prod', source: 't_categories', sourceColumn: 'c_cat_id', target: 't_products', targetColumn: 'c_prod_category_id', relationType: 'one-to-many' },
    { id: 'e_users_orders', source: 't_users', sourceColumn: 'c_users_id', target: 't_orders', targetColumn: 'c_ord_user_id', relationType: 'one-to-many' },
    { id: 'e_orders_oi', source: 't_orders', sourceColumn: 'c_ord_id', target: 't_order_items', targetColumn: 'c_oi_order_id', relationType: 'one-to-many' },
    { id: 'e_prod_oi', source: 't_products', sourceColumn: 'c_prod_id', target: 't_order_items', targetColumn: 'c_oi_product_id', relationType: 'one-to-many' },
  ],
}

export async function onboardUser(c: Context) {
  try {
    const userId = c.get('user').sub as string

    const existing = await db
      .select()
      .from(databases)
      .where(eq(databases.userid, userId))
      .limit(1)

    if (existing.length >= 1) {
      return c.json({ seeded: false }, 200)
    }

    const newDatabaseId = crypto.randomUUID()

    const [newDatabase] = await db
      .insert(databases)
      .values({
        id: newDatabaseId,
        userid: userId,
        databaseName: 'Sample E-commerce DB',
        databaseType: 'postgres',
        color: '#0db8c8',
        icon: 'cube',
        starred: false,
      })
      .returning()

    await db
      .insert(schemas)
      .values({
        id: crypto.randomUUID(),
        databaseid: newDatabaseId,
        dbmlJson: sampleSchema,
      })

    return c.json({ seeded: true, database: newDatabase }, 201)
  } catch (err) {
    console.error('[onboardUser]', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
}
