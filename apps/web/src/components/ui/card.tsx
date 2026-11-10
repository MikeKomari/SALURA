import { motion } from 'motion/react';
import { pageGroup } from '../../lib/motion.ts';

interface CardProps {
  title?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  /** Page-load group index for the staggered entrance. */
  group?: number;
}

export function Card({ title, action, className = '', children, group = 2 }: CardProps) {
  return (
    <motion.section variants={pageGroup} custom={group} className={`flex min-w-0 flex-col rounded-card bg-surface p-6 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-h2 font-semibold text-ink">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </motion.section>
  );
}
