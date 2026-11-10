import { motion, useReducedMotion } from 'motion/react';
import { ease } from '../../lib/motion.ts';

/** Half-donut from the reference "Project Progress" card. Values are 0..1 and should sum to <= 1. */
export function Gauge({ segments, centerValue, centerLabel, legend }: { segments: { value: number; color: string }[]; centerValue: string; centerLabel: string; legend: { label: string; swatch: string }[] }) {
  const reduce = useReducedMotion();
  const r = 80;
  const stroke = 30;
  const arc = `M ${100 - r} 100 A ${r} ${r} 0 0 1 ${100 + r} 100`;
  let offset = 0;

  return (
    <figure className="flex flex-col items-center">
      <div className="relative w-full max-w-[260px]">
        <svg viewBox="0 0 200 112" className="w-full" aria-hidden="true">
          <defs>
            <pattern id="gauge-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="8" height="8" fill="var(--surface)" />
              <rect width="3" height="8" fill="var(--border)" />
            </pattern>
          </defs>
          <path d={arc} fill="none" stroke="url(#gauge-hatch)" strokeWidth={stroke} strokeLinecap="round" />
          {segments.map((s, i) => {
            const start = offset;
            offset += s.value;
            if (s.value <= 0) return null;
            return (
              <motion.path
                key={i}
                d={arc}
                fill="none"
                stroke={s.color}
                strokeWidth={stroke}
                strokeLinecap="round"
                pathLength={1}
                strokeDasharray="1 1"
                initial={reduce ? false : { strokeDashoffset: 1 }}
                animate={{ strokeDashoffset: 1 - s.value }}
                style={{ rotate: 0 }}
                transition={{ duration: 0.7, ease, delay: start * 0.4 }}
                transform={`rotate(${start * 180} 100 100)`}
              />
            );
          })}
        </svg>
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="tabular text-display font-semibold text-ink">{centerValue}</span>
          <span className="text-small text-ink-2">{centerLabel}</span>
        </div>
      </div>
      <figcaption className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2">
        {legend.map((l) => (
          <span key={l.label} className="flex items-center gap-2 text-small text-ink-2">
            <span className={`size-3 rounded-full ${l.swatch}`} aria-hidden="true" />
            {l.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
