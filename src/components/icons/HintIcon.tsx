/** Lightbulb glyph replacing the old lightbulb emoji everywhere a hint/tip is shown
 * (tips button, correction card's explanation row) — see TipsPanel.tsx /
 * CorrectionCard.tsx. `currentColor` so it always matches whatever text
 * color its container already sets. */
export function HintIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
    </svg>
  );
}
