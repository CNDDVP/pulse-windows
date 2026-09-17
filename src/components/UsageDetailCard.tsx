import React from "react";
import { motion } from "framer-motion";
import { ProviderIcon } from "./icons/ProviderIcons";
import type { ProviderUsage } from "../types";

interface UsageDetailCardProps {
  usage: ProviderUsage;
  targetRect: DOMRect | null;
  dockSide: "right" | "left";
  theme: "obsidian" | "translucent";
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const UsageDetailCard: React.FC<UsageDetailCardProps> = ({
  usage,
  targetRect,
  dockSide,
  theme,
  onMouseEnter,
  onMouseLeave,
}) => {
  if (!targetRect) return null;

  const isObsidian = theme === "obsidian";

  // Calculate vertical alignment so arrow points to the ring center
  const ringCenterY = targetRect.top + targetRect.height / 2;
  const cardHeight = Math.max(140, 70 + usage.windows.length * 48);
  // Keep card within viewport top/bottom
  let cardTop = ringCenterY - cardHeight / 2;
  if (cardTop < 10) cardTop = 10;
  if (cardTop + cardHeight > 590) cardTop = 590 - cardHeight;

  const arrowOffset = ringCenterY - cardTop;

  const getBarColor = (percent: number) => {
    if (percent >= 90) return "bg-red-500";
    if (percent >= 75) return "bg-orange-500";
    if (percent >= 50) return "bg-amber-400";
    return "bg-emerald-400";
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: dockSide === "right" ? 14 : -14, scale: 0.96, top: cardTop }}
      animate={{ opacity: 1, x: 0, scale: 1, top: cardTop }}
      exit={{ opacity: 0, x: dockSide === "right" ? 14 : -14, scale: 0.96 }}
      transition={{
        top: { type: "spring", stiffness: 420, damping: 32 },
        opacity: { duration: 0.15 },
        x: { duration: 0.15 },
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        right: dockSide === "right" ? "68px" : "auto",
        left: dockSide === "left" ? "68px" : "auto",
        width: "256px",
      }}
      className={`absolute z-50 rounded-2xl p-4 pointer-events-auto ${
        isObsidian ? "card-obsidian text-zinc-100" : "card-translucent text-zinc-900"
      }`}
    >
      {/* Speech Bubble Arrow */}
      <motion.div
        animate={{
          top: Math.max(16, Math.min(arrowOffset - 8, cardHeight - 24)),
        }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        style={{
          right: dockSide === "right" ? "-7px" : "auto",
          left: dockSide === "left" ? "-7px" : "auto",
        }}
        className={`absolute w-3.5 h-3.5 rotate-45 ${
          isObsidian ? "bg-[#131317] border-t border-r border-white/10" : "bg-white border-t border-r border-black/10"
        }`}
      />

      {/* Cross-fadeable Card Content Container */}
      <motion.div
        key={usage.provider_id}
        initial={{ opacity: 0.7 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.12 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center space-x-2">
            <div className={isObsidian ? "text-zinc-200" : "text-zinc-800"}>
              <ProviderIcon id={usage.provider_id} size={18} />
            </div>
            <span className="font-bold text-[14px] tracking-tight">
              {usage.display_name} 用量
            </span>
          </div>
          {usage.plan_name && (
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                isObsidian ? "bg-zinc-800 text-zinc-300" : "bg-zinc-100 text-zinc-700"
              }`}
            >
              {usage.plan_name}
            </span>
          )}
        </div>

        {/* Content: Windows / Pools */}
        {usage.windows && usage.windows.length > 0 ? (
          <div className="space-y-3.5">
            {usage.windows.map((win) => (
              <div key={win.id} className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className={`font-medium ${isObsidian ? "text-zinc-300" : "text-zinc-700"}`}>
                    {win.name}
                  </span>
                  {win.resets_in && (
                    <span className={`text-[10px] ${isObsidian ? "text-zinc-400" : "text-zinc-500"}`}>
                      {win.resets_in}
                    </span>
                  )}
                </div>

                {/* Progress Bar */}
                <div
                  className={`w-full h-1.5 rounded-full overflow-hidden ${
                    isObsidian ? "bg-zinc-800" : "bg-zinc-200"
                  }`}
                >
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(win.used_percent, 100)}%` }}
                    transition={{ duration: 0.5, ease: "easeOut" }}
                    className={`h-full rounded-full ${getBarColor(win.used_percent)}`}
                  />
                </div>

                <div className="flex justify-between items-center text-[10px]">
                  <span className={isObsidian ? "text-zinc-400" : "text-zinc-600"}>
                    已用 {win.used_percent}%
                  </span>
                  {win.resets_at && (
                    <span className={isObsidian ? "text-zinc-500" : "text-zinc-400"}>
                      {win.resets_at.slice(5, 16).replace("T", " ")}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-2 text-center">
            <p className={`text-[12px] ${isObsidian ? "text-zinc-400" : "text-zinc-500"}`}>
              {usage.error_message || "暂无配额数据"}
            </p>
            <p className={`text-[10px] mt-1 ${isObsidian ? "text-zinc-500" : "text-zinc-400"}`}>
              右键悬浮条进入设置进行配置
            </p>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
};
