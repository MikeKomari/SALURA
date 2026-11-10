import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

/** Animates from the previous value to the new one (DESIGN.md §12), never from 0 on every render. */
export function CountUp({ value, format = (n) => String(Math.round(n)) }: { value: number; format?: (n: number) => string }) {
  const reduce = useReducedMotion();
  const prev = useRef<number | null>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const from = prev.current ?? 0;
    prev.current = value;
    if (reduce || from === value) {
      setShown(value);
      return;
    }
    const controls = animate(from, value, { duration: 0.6, ease: [0.2, 0, 0, 1], onUpdate: setShown });
    return () => controls.stop();
  }, [value, reduce]);

  return <span className="tabular">{format(shown)}</span>;
}
