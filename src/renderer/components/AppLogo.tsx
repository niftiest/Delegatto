/** The app's icon: the cat on its slate tile, as in resources/icon.svg. */
export function AppLogo({ size, className }: { size: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
      <rect width="100" height="100" rx="30" fill="#4A5360" />
      <g transform="translate(50 50) scale(0.921) translate(-50 -51)">
        <circle cx="28" cy="24" r="8" fill="#F2A044" />
        <circle cx="72" cy="24" r="8" fill="#F2A044" />
        <rect x="12" y="24" width="76" height="62" rx="24" fill="#F2A044" />
        <rect x="33" y="42" width="8" height="18" rx="4" fill="#1C1A19" />
        <rect x="59" y="52" width="13" height="8" rx="4" fill="#1C1A19" />
        <path d="M40 70 Q50 77 60 70" fill="none" stroke="#1C1A19" strokeWidth="5" strokeLinecap="round" />
      </g>
    </svg>
  )
}
