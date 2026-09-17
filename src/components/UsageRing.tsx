import React from "react";
import { motion } from "framer-motion";
import { ProviderIcon } from "./icons/ProviderIcons";
import type { ProviderUsage } from "../types";

interface UsageRingProps {
  usage: ProviderUsage;
  isHovered: boolean;
  theme: "obsidian" | "translucent";
  onHover: (rect: DOMRect) => void;
  onLeave?: () => void;
}

export const UsageRing: React.FC<UsageRingProps> = ({
  usage,
  isHovered,
  theme,
  onHover,
  onLeave,
}) => {
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Ring geometry
  const radius = 18;
  const strokeWidth = 2.8;
  const circumference = 2 * Math.PI * radius;
  const percent = Math.min(Math.max(usage.primary_percent, 0), 100);
  const strokeDashoffset = circumference - (percent / 100) * circumference;

  // Dynamic Color
  const getRingColor = () => {
    if (usage.state === "unavailable" || usage.state === "error") {
      return theme === "obsidian" ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)";
    }
    if (percent >= 90) return "#ef4444"; // Deep red
    if (percent >= 75) return "#f97316"; // Orange
    if (percent >= 50) return "#eab308"; // Amber/Yellow
    return "#10b981"; // Emerald green
  };

  const ringColor = getRingColor();

  const handleMouseEnter = () => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      onHover(rect);
    }
  };

  const isObsidian = theme === "obsidian";

  return (
    <div
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onLeave}
      className="relative flex flex-col items-center justify-center cursor-pointer py-1.5 px-2 group"
    >
      {/* Ring & Icon Wrapper */}
      <div className="relative w-11 h-11 flex items-center justify-center">
        {/* SVG Progress Arc */}
        <svg className="w-11 h-11 -rotate-90 transform" viewBox="0 0 44 44">
          {/* Background Track */}
          <circle
            cx="22"
            cy="22"
            r={radius}
            stroke={isObsidian ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.08)"}
            strokeWidth={strokeWidth}
            fill="transparent"
          />
          {/* Active Progress Arc */}
          <motion.circle
            cx="22"
            cy="22"
            r={radius}
            stroke={ringColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            strokeLinecap="round"
            fill="transparent"
          />
        </svg>

        {/* Center Provider Icon */}
        <div
          className={`absolute inset-1.5 rounded-full flex items-center justify-center transition-transform duration-200 ${
            isHovered ? "scale-110" : "scale-100"
          } ${
            isObsidian
              ? "text-zinc-200 bg-zinc-800/40"
              : "text-zinc-700 bg-black/5"
          }`}
        >
          <ProviderIcon id={usage.provider_id} size={17} />
        </div>

        {/* Revolving Active Dot Indicator (if agent is running) */}
        {usage.is_active && (
          <motion.div
            className="absolute inset-0 pointer-events-none"
            animate={{ rotate: 360 }}
            transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
          >
            <div
              className="w-1.5 h-1.5 rounded-full bg-white shadow-[0_0_6px_#ffffff]"
              style={{ position: "absolute", top: "1px", left: "calc(50% - 3px)" }}
            />
          </motion.div>
        )}
      </div>

      {/* Percentage Text Below Ring */}
      <span
        className={`text-[11px] font-semibold tracking-tight mt-0.5 transition-colors ${
          isObsidian ? "text-zinc-300" : "text-zinc-700"
        } ${isHovered ? "font-bold text-white" : ""}`}
      >
        {usage.state === "unavailable" ? "--" : `${percent}%`}
      </span>
    </div>
  );
};
