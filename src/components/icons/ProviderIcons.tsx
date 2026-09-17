import React from "react";

interface IconProps {
  className?: string;
  size?: number;
}

export const ClaudeIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    {/* Claude Asterisk / Starburst */}
    <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07L19.07 4.93" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

export const OpenAIIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 716 716" fill="currentColor" className={className}>
    {/* OpenAI "Blossom" mark, path from the official brand kit (OAI_OpenAI-Blossom_Black.svg) */}
    <path d="M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z" />
  </svg>
);

export const AntigravityIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="6 8 100 100" fill="currentColor" className={className}>
    {/* Google Antigravity mark (peak with flared legs), geometry from the official wordmark SVG */}
    <path d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z" />
  </svg>
);

export const CursorIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    {/* Cursor Beveled Box */}
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <rect x="8" y="8" width="8" height="8" rx="1.5" />
  </svg>
);

export const KimiIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    {/* Kimi K. style */}
    <text x="12" y="17" fontSize="15" fontWeight="bold" textAnchor="middle" fill="currentColor" fontFamily="sans-serif">
      K.
    </text>
  </svg>
);

export const CopilotIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.87 1.52 2.34 1.07 2.91.83.1-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2z" />
  </svg>
);

export const DeepSeekIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <path d="M4 12a8 8 0 0 1 16 0c0 4.42-3.58 8-8 8H4v-8z" />
    <circle cx="9" cy="11" r="1.5" fill="currentColor" />
  </svg>
);

export const ZhipuIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    {/* Zhipu / z.ai wordmark: a heavy slab Z with slanted bar ends */}
    <path d="M5.5 4H20v3.3L11.1 16.7H19v3.3H4v-3.3L12.9 7.3H5.5z" />
  </svg>
);

export const ProviderIcon: React.FC<{ id: string; className?: string; size?: number }> = ({ id, className, size }) => {
  switch (id.toLowerCase()) {
    case "claude":
      return <ClaudeIcon className={className} size={size} />;
    case "codex":
    case "openai":
      return <OpenAIIcon className={className} size={size} />;
    case "antigravity":
      return <AntigravityIcon className={className} size={size} />;
    case "cursor":
      return <CursorIcon className={className} size={size} />;
    case "kimi":
      return <KimiIcon className={className} size={size} />;
    case "copilot":
      return <CopilotIcon className={className} size={size} />;
    case "deepseek":
      return <DeepSeekIcon className={className} size={size} />;
    case "zai":
    case "zhipu":
      return <ZhipuIcon className={className} size={size} />;
    default:
      return (
        <svg width={size || 18} height={size || 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      );
  }
};
