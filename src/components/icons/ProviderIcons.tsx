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
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
    {/* OpenAI Swirl */}
    <path d="M19.5 9.5c.3-1.8-.7-3.6-2.5-4.2-1.2-.4-2.5-.1-3.4.6-.7-1.3-2.1-2.1-3.6-2-1.8.2-3.3 1.6-3.6 3.4-.9.4-1.7 1.1-2.1 2-1 1.6-.7 3.6.6 4.8-.3 1.8.7 3.6 2.5 4.2 1.2.4 2.5.1 3.4-.6.7 1.3 2.1 2.1 3.6 2 1.8-.2 3.3-1.6 3.6-3.4.9-.4 1.7-1.1 2.1-2 1-1.6.7-3.6-.6-4.8z" />
    <path d="M12 8.5v7M8.5 10.2l7 3.6M8.5 13.8l7-3.6" />
  </svg>
);

export const AntigravityIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
    {/* Antigravity Multi-facet Chevron/Hexagon */}
    <polygon points="12 2 21 8.5 21 15.5 12 22 3 15.5 3 8.5" />
    <line x1="12" y1="2" x2="12" y2="22" />
    <line x1="3" y1="8.5" x2="21" y2="15.5" />
    <line x1="3" y1="15.5" x2="21" y2="8.5" />
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
