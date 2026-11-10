import { closeDb, openDb } from '../index.ts';
import { databaseUrl } from './url.ts';

// Applies pending migrations. Run before deploying: the Vercel handler never migrates.
const url = databaseUrl();
const db = await openDb(url, { maxConnections: 1 });
await closeDb(db);
console.log(`Migrated ${url.replace(/:[^:@/]+@/, ':***@')}`);
