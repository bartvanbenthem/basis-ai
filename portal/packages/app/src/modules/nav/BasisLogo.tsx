/** The BASIS mark (from logos/basis-icon.svg) with its wordmark. */
export const BasisLogo = ({ height = 30 }: { height?: number }) => (
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
      aria-label="BASIS"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="60" cy="60" r="56" fill="#0F3A4A" />
      <path d="M60 73 L89 86 L60 99 L31 86 Z" fill="#EFE8D6" />
      <path d="M60 57 L89 70 L60 83 L31 70 Z" fill="#EFE8D6" fillOpacity=".7" />
      <path
        d="M60 41 L89 54 L60 67 L31 54 Z"
        fill="#EFE8D6"
        fillOpacity=".42"
      />
      <path
        d="M60 18 C 61.2 27, 63 28.8, 72 30 C 63 31.2, 61.2 33, 60 42 C 58.8 33, 57 31.2, 48 30 C 57 28.8, 58.8 27, 60 18 Z"
        fill="#D2232A"
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
      BASIS
    </span>
  </span>
);
