import React from "react";
import { siClaude, siCursor, siDeepseek, siGithubcopilot, siKimi, siMinimax, siZdotai, siOllama, siOpencode } from "simple-icons";

interface IconProps { className?: string; size?: number }

/** Every brand mark renders from a 24×24 path filled with currentColor so it follows the
 *  theme and the ring state. Simple-icons paths are height-normalized, which keeps all
 *  providers visually the same size. */
function BrandIcon({ icon, className = "w-4 h-4", size = 18 }: IconProps & { icon: { path: string } }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d={icon.path} />
    </svg>
  );
}

export const ClaudeIcon: React.FC<IconProps> = p => <BrandIcon {...p} icon={siClaude} />;
export const CursorIcon: React.FC<IconProps> = p => <BrandIcon {...p} icon={siCursor} />;
export const DeepSeekIcon: React.FC<IconProps> = p => <BrandIcon {...p} icon={siDeepseek} />;
export const CopilotIcon: React.FC<IconProps> = p => <BrandIcon {...p} icon={siGithubcopilot} />;
export const KimiIcon: React.FC<IconProps> = p => <BrandIcon {...p} icon={siKimi} />;
export const MiniMaxIcon: React.FC<IconProps> = p => <BrandIcon {...p} icon={siMinimax} />;
export const ZaiIcon: React.FC<IconProps> = p => <BrandIcon {...p} icon={siZdotai} />;
export const OllamaIcon: React.FC<IconProps> = p => <BrandIcon {...p} icon={siOllama} />;
export const OpenCodeIcon: React.FC<IconProps> = p => <BrandIcon {...p} icon={siOpencode} />;

/** OpenAI "Blossom", the classic height-normalized path of the official mark — the same
 *  shape as OAI_OpenAI-Blossom_Black.svg but scaled to fill the 24×24 box like the rest. */
export const OpenAIIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
);

/** Google Antigravity mark (peak with flared legs), geometry from the official wordmark SVG. */
export const AntigravityIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="6 8 100 100" fill="currentColor" className={className}>
    <path d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z" />
  </svg>
);

/** Zhipu wordmark: the heavy slab Z the user picked. */
export const ZhipuIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M5.5 4H20v3.3L11.1 16.7H19v3.3H4v-3.3L12.9 7.3H5.5z" />
  </svg>
);

/** Grok (xAI): the slanted cross mark. */
export const GrokIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" className={className}>
    <path d="M6.5 5 17.5 19M17.5 5 6.5 19" transform="skewX(-10)" />
  </svg>
);

/** Volcengine (火山引擎): flame mark. */
export const VolcengineIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M12 2.5c3 3.6 6.5 6.2 6.5 10.3a6.5 6.5 0 0 1-13 0C5.5 8.7 9 6.1 12 2.5zm0 16.4a4.1 4.1 0 0 0 4.1-4.1c0-1.6-1-2.9-2.4-4.3-.5.9-1.2 1.5-2 1.5-1.3 0-2-1.1-2.3-2.4-1 1.3-1.5 3-1.5 5.2A4.1 4.1 0 0 0 12 18.9z" />
  </svg>
);

/** Devin (Cognition): slab D. */
export const DevinIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M5 4h7a8 8 0 0 1 0 16H5V4zm3.2 3v10H12a5 5 0 0 0 0-10H8.2z" />
  </svg>
);

/** Command Code: terminal prompt. */
export const CommandCodeIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M5 6l6 6-6 6M13 18h6" />
  </svg>
);

/** StepFun (阶跃星辰): 5-square "S" mark from official StepFun branding. */
export const StepFunIcon: React.FC<IconProps> = ({ className = "w-4 h-4", size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    {/* Top row */}
    <rect x="9.2" y="2.4" width="5.6" height="5.6" rx="0.8" />
    <rect x="16.0" y="2.4" width="5.6" height="5.6" rx="0.8" />
    {/* Middle row */}
    <rect x="9.2" y="9.2" width="5.6" height="5.6" rx="0.8" />
    {/* Bottom row */}
    <rect x="2.4" y="16.0" width="5.6" height="5.6" rx="0.8" />
    <rect x="9.2" y="16.0" width="5.6" height="5.6" rx="0.8" />
  </svg>
);

export const ProviderIcon: React.FC<{ id: string; className?: string; size?: number }> = ({ id, className, size }) => {
  switch (id.toLowerCase()) {
    case "claude": return <ClaudeIcon className={className} size={size} />;
    case "codex": case "openai": return <OpenAIIcon className={className} size={size} />;
    case "antigravity": return <AntigravityIcon className={className} size={size} />;
    case "cursor": return <CursorIcon className={className} size={size} />;
    case "kimi": return <KimiIcon className={className} size={size} />;
    case "copilot": return <CopilotIcon className={className} size={size} />;
    case "deepseek": return <DeepSeekIcon className={className} size={size} />;
    case "stepfun": return <StepFunIcon className={className} size={size} />;
    case "zai": return <ZaiIcon className={className} size={size} />;
    case "zhipu": return <ZhipuIcon className={className} size={size} />;
    case "grok": case "grok-bot": return <GrokIcon className={className} size={size} />;
    case "ollama": return <OllamaIcon className={className} size={size} />;
    case "minimax": case "minimax-cn": return <MiniMaxIcon className={className} size={size} />;
    case "volcengine": return <VolcengineIcon className={className} size={size} />;
    case "command-code": return <CommandCodeIcon className={className} size={size} />;
    case "devin": return <DevinIcon className={className} size={size} />;
    case "opencode": return <OpenCodeIcon className={className} size={size} />;
    default:
      return (
        <svg width={size || 18} height={size || 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      );
  }
};
