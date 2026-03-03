import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from './env';
import postgres from 'postgres';

export const connectDB = async () => {
  const client = postgres(env.DB_URI, { prepare: false })
  const db = drizzle(client);

  console.log("database connected");
}