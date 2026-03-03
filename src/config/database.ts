import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from './env';
import postgres from 'postgres';

const client = postgres(env.DB_URI, { prepare: false });
export const db = drizzle(client);

export const connectDB = () => {
  console.log("database connected");
};
