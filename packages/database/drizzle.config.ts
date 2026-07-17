import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const environmentPath = join(workspaceRoot, '.env');
if (existsSync(environmentPath)) process.loadEnvFile(environmentPath);

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
