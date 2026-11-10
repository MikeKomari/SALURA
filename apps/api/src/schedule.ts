import type { SaluraService } from '@salura/agent';

/** Runs a job once a day at the given hour, Asia/Jakarta (UTC+7, no DST). */
function daily(hourWib: number, name: string, job: () => Promise<{ runId: string; status: string }>, clock: () => Date) {
  const scheduleNext = () => {
    const now = clock();
    const next = new Date(now);
    next.setUTCHours(hourWib - 7, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(async () => {
      try {
        const result = await job();
        console.log(`${name} run ${result.runId}: ${result.status}`);
      } catch (err) {
        console.error(`${name} run failed`, err);
      }
      scheduleNext();
    }, next.getTime() - now.getTime()).unref();
  };
  scheduleNext();
}

/** The two autonomous jobs: reorder offers at 08:00, payment reminders at 09:00. */
export function startAgentSchedules(service: SaluraService, clock: () => Date) {
  daily(8, 'Proactive reorder', () => service.runProactive('schedule'), clock);
  daily(9, 'Collections', () => service.runCollections('schedule'), clock);
}
