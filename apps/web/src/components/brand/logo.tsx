/**
 * The SALURA "Nota-chat" mark: a receipt with a torn top edge whose bottom-left corner is a chat tail.
 * Geometry is the small-size cut from docs/brand/build_logo.py (MARK_SMALL); keep the two in sync.
 * Masters, lockups and usage notes live in docs/brand/.
 */
const MARK_SMALL =
  'M56,58 L92,30 L128,58 L164,30 L200,58 V154 A40,40 0 0 1 160,194 H100 L56,222 Z M99,88 H157 A11,11 0 0 1 157,110 H99 A11,11 0 0 1 99,88 Z M99,130 H129 A11,11 0 0 1 129,152 H99 A11,11 0 0 1 99,130 Z';

/** The app-icon tile: white mark on the primary green, as on the favicon and the installed app. */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <rect width="64" height="64" rx="16" fill="var(--primary)" />
      <path fill="#fff" fillRule="evenodd" transform="translate(32 31.36) scale(0.2) translate(-128 -126)" d={MARK_SMALL} />
    </svg>
  );
}

/** The bare mark in the current text colour, for inline use (for example next to "SALURA" in chat). */
export function LogoMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={Math.round((size * 176) / 212)} height={size} viewBox="40 22 176 212" aria-hidden="true" className={`shrink-0 ${className ?? ''}`}>
      <path fill="currentColor" fillRule="evenodd" d={MARK_SMALL} />
    </svg>
  );
}
