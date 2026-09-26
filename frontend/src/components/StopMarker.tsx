/**
 * A stop flag on its pole. Inline SVG so it inherits the text colour and flips
 * with the theme, which the 🚏 emoji it replaces did not — and so it renders the
 * same on every platform rather than as each vendor's own drawing.
 */
export function StopMarker({ className = 'stop-icon' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="3" y="1.5" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 8.5V15M5.5 15h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
