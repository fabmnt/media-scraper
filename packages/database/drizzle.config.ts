import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run database commands');
}

export default defineConfig({
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/schema.ts',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
