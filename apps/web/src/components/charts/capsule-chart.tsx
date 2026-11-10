import { motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import { dayShort } from '../../lib/format.ts';
import { ease } from '../../lib/motion.ts';

const FILLS = ['bg-primary', 'bg-chart-2', 'bg-chart-3'];

/** Capsule bars from the reference "Project Analytics" card: one per day, hatched when empty. */
export function CapsuleChart({ data, label }: { data: { date: string; count: number }[]; label: string }) {
  const reduce = useReducedMotion();
  const max = Math.max(1, ...data.map((d) => d.count));
  const peak = data.reduce((best, d, i) => (d.count > (data[best]?.count ?? -1) ? i : best), 0);
  const [active, setActive] = useState<number | null>(null);
  const shown = active ?? peak;

  return (
    <figure className="flex h-full flex-col">
      <figcaption className="sr-only">
        {label}: {data.map((d) => `${dayShort(d.date)} ${d.count}`).join(', ')}
      </figcaption>
      <div className="flex min-h-[180px] flex-1 items-end justify-between gap-2 sm:gap-4" aria-hidden="true">
        {data.map((d, i) => {
          const empty = d.count === 0;
          const height = empty ? 100 : Math.max(28, (d.count / max) * 100);
          return (
            <div key={d.date} className="relative flex h-full flex-1 flex-col items-center justify-end" onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
              {i === shown && !empty && (
                <motion.span
                  key={`tip-${d.date}`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="tabular absolute z-10 rounded-pill border border-border bg-surface px-2 py-0.5 text-meta font-semibold whitespace-nowrap text-ink shadow-pop"
                  style={{ bottom: `calc(${height}% + 8px)` }}
                >
                  {d.count} pesanan
                </motion.span>
              )}
              <motion.div
                initial={reduce ? false : { scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={{ duration: 0.4, ease, delay: i * 0.04 }}
                style={{ height: `${height}%`, transformOrigin: 'bottom' }}
                className={`w-full max-w-[56px] rounded-pill ${empty ? 'hatch' : FILLS[i === peak ? 0 : i % 2 === 0 ? 1 : 2]}`}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex justify-between gap-2 sm:gap-4" aria-hidden="true">
        {data.map((d) => (
          <span key={d.date} className="flex-1 text-center text-small text-ink-3 capitalize">
            {dayShort(d.date)}
          </span>
        ))}
      </div>
    </figure>
  );
}
