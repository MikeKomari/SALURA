import { closeDb, openDb, resetDb, seed } from '../index.ts';
import { databaseUrl } from './url.ts';

// Wipes the demo data (accounts and eval reports are kept) and loads the synthetic distributor.
const url = databaseUrl();
const db = await openDb(url, { maxConnections: 1 });
await resetDb(db);
await seed(db);
await closeDb(db);
console.log(`Seeded ${url.replace(/:[^:@/]+@/, ':***@')}`);
