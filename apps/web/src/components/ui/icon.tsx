import type { LucideIcon } from 'lucide-react';

type Props = { icon: LucideIcon; size?: 16 | 20 | 24; weight?: 'regular' | 'semibold'; className?: string };

/** Single place for Lucide defaults (DESIGN.md §13). */
export function Icon({ icon: Glyph, size = 20, weight = 'regular', className }: Props) {
  return <Glyph size={size} strokeWidth={weight === 'semibold' ? 2 : 1.5} className={className} aria-hidden="true" />;
}
