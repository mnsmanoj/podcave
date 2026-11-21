// Original bat drawings for Pod Cave.
export const BAT_PATH =
  'M50 15 L46.5 6 L44.5 13.5 C38 12.4 30 8.6 21.5 7.2 C11.5 7.6 4 15 2.6 24 C8.4 20.6 14.4 21.4 17.6 26.6 C21.6 22.8 27.6 23.2 30.8 29.6 C35 25.8 41 27.8 42.8 35.2 L50 47 L57.2 35.2 C59 27.8 65 25.8 69.2 29.6 C72.4 23.2 78.4 22.8 82.4 26.6 C85.6 21.4 91.6 20.6 97.4 24 C96 15 88.5 7.6 78.5 7.2 C70 8.6 62 12.4 55.5 13.5 L53.5 6 Z';

/** Pod Cave logo: a white bat with fully spread wings. */
export function BatEmblem({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.56} viewBox="0 0 100 52" className="emblem" aria-hidden>
      <path d={BAT_PATH} fill="#f4f5f7" />
    </svg>
  );
}

/** Cave Signal art: a searchlight beam sweeping the sky with a bat flying through it. */
export function BatSignalArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 240 160" aria-hidden>
      <defs>
        <linearGradient id="beam" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#f5c518" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#f5c518" stopOpacity="0.04" />
        </linearGradient>
        <radialGradient id="haze" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f5c518" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#f5c518" stopOpacity="0" />
        </radialGradient>
      </defs>
      <polygon points="112,160 128,160 214,24 26,24" fill="url(#beam)" className="beam" />
      <ellipse cx="120" cy="48" rx="100" ry="40" fill="url(#haze)" className="glow" />
      <g transform="translate(76 26) scale(0.88)">
        <path d={BAT_PATH} fill="#f4f5f7" />
      </g>
    </svg>
  );
}
