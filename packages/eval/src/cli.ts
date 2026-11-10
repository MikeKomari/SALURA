import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { closeDb, evalReports, openDb } from '@salura/db';
import { loadAgentEnv, modelFromEnv, pricingFromEnv } from '@salura/agent';
import { runEval } from './run.ts';

const { values } = parseArgs({
  // pnpm forwards a literal `--` (pnpm eval -- --k 1); it is not an argument.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    k: { type: 'string', default: '5' },
    concurrency: { type: 'string', default: '4' },
    case: { type: 'string', multiple: true },
    category: { type: 'string', multiple: true },
    /** Also store the report in DATABASE_URL, where the deployed console reads it. */
    publish: { type: 'boolean', default: false },
  },
});

const env = loadAgentEnv();
if (!env.LLM_API_KEY) {
  console.error('LLM_API_KEY is not set. The evaluation measures the real model, so it needs a key in .env.');
  process.exit(1);
}

const k = Number(values.k);
const report = await runEval({
  model: modelFromEnv(env),
  pricing: pricingFromEnv(env),
  k,
  concurrency: Number(values.concurrency),
  filter: (c) => (!values.case?.length || values.case.includes(c.id)) && (!values.category?.length || values.category.includes(c.category)),
  onRun: (r) => {
    const failed = r.grade.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    console.log(`${r.grade.pass ? 'PASS' : 'FAIL'} ${r.caseId} #${r.attempt + 1} ${r.seconds.toFixed(1)}s${failed.length ? `  ${failed.join('; ')}` : ''}`);
  },
});

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
console.log(`\n${report.summary.cases} cases × k=${k} on ${report.model}`);
console.log(`pass rate ${pct(report.summary.passRate)} · pass^${k} ${pct(report.summary.passK)} · item accuracy ${pct(report.summary.itemAccuracy)} · ${report.summary.avgSecondsPerTurn.toFixed(1)} s/turn`);
for (const [cat, s] of Object.entries(report.summary.byCategory)) console.log(`  ${cat.padEnd(13)} ${s.cases} cases · pass ${pct(s.passRate)} · pass^k ${pct(s.passK)}`);

const outDir = resolve(dirname(new URL(import.meta.url).pathname), '../results');
mkdirSync(outDir, { recursive: true });
const stamp = report.ranAt.replace(/[:.]/g, '-');
writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, 'latest.json'), JSON.stringify(report, null, 2));
console.log(`\nSaved packages/eval/results/latest.json`);

// The console (Evaluasi page, dashboard) reads the latest report from the database.
if (values.publish) {
  const target = process.env.DATABASE_URL?.trim();
  if (!target) {
    console.error('--publish needs DATABASE_URL (the database the console reads).');
    process.exit(1);
  }
  const db = await openDb(target, { maxConnections: 1 });
  await db.insert(evalReports).values({ ranAt: report.ranAt, report: report as unknown as Record<string, unknown> });
  await closeDb(db);
  console.log('Published the report to the database; the console shows it now.');
} else console.log('Add --publish to show this report in the console (stores it in DATABASE_URL).');
