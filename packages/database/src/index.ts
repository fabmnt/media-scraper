import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl);
  return {
    db: drizzle(client, { schema }),
    close: () => client.end(),
  };
}

export type Database = ReturnType<typeof createDatabase>['db'];

export * from './credential-states.js';
export * from './maintenance.js';
