import { ArrowUpRight } from 'lucide-react';
import { motion } from 'motion/react';
import { Link } from 'react-router';
import { hover, pageGroup } from '../../lib/motion.ts';
import { CountUp } from './count-up.tsx';
import { Icon } from './icon.tsx';
import { Skeleton } from './feedback.tsx';

interface KpiCardProps {
  title: string;
  value: number | null;
  format?: (n: number) => string;
  footer: React.ReactNode;
  to: string;
  highlighted?: boolean;
  loading?: boolean;
}

/** Stat tile from the reference dashboard. Exactly one per row is highlighted. */
export function KpiCard({ title, value, format, footer, to, highlighted, loading }: KpiCardProps) {
  return (
    <motion.div variants={pageGroup} custom={1} className="min-w-0">
      <motion.div whileHover="hover" initial="rest" animate="rest" className="h-full">
        <Link
          to={to}
          className={`flex h-full flex-col gap-3 rounded-card p-6 outline-offset-4 transition-shadow duration-150 ${
            highlighted ? 'text-white' : 'bg-surface text-ink'
          }`}
          style={highlighted ? { background: 'var(--gradient-feature)' } : undefined}
        >
          <motion.div variants={{ rest: { y: 0 }, hover: { y: -2 } }} transition={hover} className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-h3 font-semibold">{title}</h2>
              <motion.span
                variants={{ rest: { rotate: 0 }, hover: { rotate: 45 } }}
                transition={hover}
                className={`grid size-9 shrink-0 place-items-center rounded-full border ${highlighted ? 'border-white/70 bg-white text-primary' : 'border-ink text-ink'}`}
              >
                <Icon icon={ArrowUpRight} size={20} weight="semibold" />
              </motion.span>
            </div>
            {loading || value === null ? (
              loading ? <Skeleton className="h-[52px] w-28" /> : <span className="text-display font-semibold">–</span>
            ) : (
              <span className="text-display font-semibold">
                <CountUp value={value} format={format} />
              </span>
            )}
            <div className={`text-small ${highlighted ? 'text-primary-on-strong' : 'text-ink-2'}`}>{footer}</div>
          </motion.div>
        </Link>
      </motion.div>
    </motion.div>
  );
}
