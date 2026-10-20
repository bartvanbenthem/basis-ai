/** The Tuskpilot mark (from logos/tuskpilot-icon.svg) with its wordmark. */
export const TuskpilotLogo = ({ height = 30 }: { height?: number }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: Math.round(height * 0.3),
    }}
  >
    <svg
      height={height}
      width={height}
      viewBox="4 4 112 112"
      role="img"
      aria-label="Tuskpilot"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="60" cy="60" r="56" fill="#0F3A4A" />
      <circle
        cx="60"
        cy="60"
        r="45"
        fill="none"
        stroke="#EFE8D6"
        strokeOpacity=".28"
        strokeWidth="2"
      />
      <rect x="58.5" y="10" width="3" height="10" rx="1.5" fill="#D2232A" />
      <rect
        x="100"
        y="58.5"
        width="10"
        height="3"
        rx="1.5"
        fill="#EFE8D6"
        fillOpacity=".55"
      />
      <rect
        x="58.5"
        y="100"
        width="3"
        height="10"
        rx="1.5"
        fill="#EFE8D6"
        fillOpacity=".55"
      />
      <rect
        x="10"
        y="58.5"
        width="10"
        height="3"
        rx="1.5"
        fill="#EFE8D6"
        fillOpacity=".55"
      />
      <path
        d="M26 72 C 30 102, 80 106, 91 25 C 76 74, 54 80, 42 60 Z"
        fill="#EFE8D6"
      />
      <path
        d="M26 72 L42 60 L45.5 66 C 40 70, 34 75, 29.5 79 Z"
        fill="#0F3A4A"
        fillOpacity=".35"
      />
    </svg>
    <span
      style={{
        fontSize: Math.round(height * 0.72),
        fontWeight: 600,
        letterSpacing: '0.01em',
        color: '#e9ebf0',
        lineHeight: 1,
      }}
    >
      Tuskpilot
    </span>
  </span>
);
