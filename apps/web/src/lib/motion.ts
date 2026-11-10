import type { Transition, Variants } from 'motion/react';

// Shared motion tokens (DESIGN.md §12). Components import these instead of inventing timings.
export const ease = [0.2, 0, 0, 1] as const;

export const press: Transition = { type: 'spring', stiffness: 500, damping: 30, bounce: 0 };
export const fast: Transition = { duration: 0.15, ease };
export const hover: Transition = { duration: 0.18, ease };
export const panel: Transition = { duration: 0.25, ease };

/** Page-load sequence: groups (header, KPI row, bento) appear 60ms apart. */
export const pageGroup: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: (i: number = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.25, ease, delay: i * 0.06 } }),
};

/** New chat bubble, trace step or list row. */
export const itemIn: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease } },
  exit: { opacity: 0, height: 0, transition: { duration: 0.22, ease } },
};

export const liftOnHover = { whileHover: { y: -2 }, transition: hover };
