import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { UsageRing } from "./UsageRing";
import { UsageDetailCard } from "./UsageDetailCard";
import type { AppSettings, ProviderUsage } from "../types";

interface FloatingRailProps {
  usages: ProviderUsage[];
  settings: AppSettings;
  onRefresh: () => void;
}

export const FloatingRail: React.FC<FloatingRailProps> = ({
  usages,
  settings,
}) => {
  const [hoveredProviderId, setHoveredProviderId] = useState<string | null>(null);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);

  const isMouseOverRailRef = useRef<boolean>(false);
  const isMouseOverCardRef = useRef<boolean>(false);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dockSide = settings.dock_side || "right";
  const theme = settings.theme || "obsidian";
  const autoCollapseDelay = (settings.auto_collapse_seconds || 3) * 1000;

  // Sync window size with backend based on state
  const updateWindowState = (state: "collapsed" | "rail" | "expanded") => {
    invoke("set_window_state", { side: dockSide, state }).catch(console.error);
  };

  // Auto collapse timer logic
  const startCollapseTimer = () => {
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
    if (autoCollapseDelay <= 0) return;

    collapseTimerRef.current = setTimeout(() => {
      if (!isMouseOverRailRef.current && !isMouseOverCardRef.current && !hoveredProviderId) {
        setIsCollapsed(true);
        updateWindowState("collapsed");
      }
    }, autoCollapseDelay);
  };

  const cancelCollapseTimer = () => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  };

  const cancelLeaveTimer = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  };

  // Schedule un-hover when mouse leaves both rail and card
  const scheduleLeaveCheck = () => {
    cancelLeaveTimer();
    leaveTimerRef.current = setTimeout(() => {
      if (!isMouseOverRailRef.current && !isMouseOverCardRef.current) {
        setHoveredProviderId(null);
        setTargetRect(null);
        updateWindowState("rail");
        startCollapseTimer();
      }
    }, 200);
  };

  const handleMouseEnterRail = () => {
    cancelCollapseTimer();
    cancelLeaveTimer();
    isMouseOverRailRef.current = true;
    if (isCollapsed) {
      setIsCollapsed(false);
      updateWindowState("rail");
    }
  };

  const handleMouseLeaveRail = () => {
    isMouseOverRailRef.current = false;
    scheduleLeaveCheck();
  };

  const handleCardMouseEnter = () => {
    cancelCollapseTimer();
    cancelLeaveTimer();
    isMouseOverCardRef.current = true;
  };

  const handleCardMouseLeave = () => {
    isMouseOverCardRef.current = false;
    scheduleLeaveCheck();
  };

  const handleRingHover = (id: string, rect: DOMRect) => {
    cancelCollapseTimer();
    cancelLeaveTimer();
    setHoveredProviderId(id);
    setTargetRect(rect);
    updateWindowState("expanded");
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    invoke("open_settings").catch(console.error);
  };

  useEffect(() => {
    startCollapseTimer();
    return () => {
      cancelCollapseTimer();
      cancelLeaveTimer();
    };
  }, [autoCollapseDelay]);

  const activeUsage = usages.find((u) => u.provider_id === hoveredProviderId);
  const isObsidian = theme === "obsidian";

  // Calculate highest usage percentage across all active providers for sliver glow color
  const maxPressure = usages.reduce((max, u) => Math.max(max, u.primary_percent), 0);
  const sliverGlowClass =
    maxPressure >= 90
      ? "sliver-glow-danger bg-red-500"
      : maxPressure >= 75
      ? "sliver-glow-warn bg-amber-400"
      : "sliver-glow bg-emerald-400";

  return (
    <div
      className="relative w-full h-full flex items-center justify-end select-none overflow-visible pointer-events-none"
      onContextMenu={handleContextMenu}
    >
      {/* 1. Collapsed Sliver (闲时微光边缘窄条) */}
      <AnimatePresence>
        {isCollapsed && (
          <motion.div
            initial={{ opacity: 0, x: dockSide === "right" ? 10 : -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: dockSide === "right" ? 10 : -10 }}
            transition={{ duration: 0.25 }}
            onMouseEnter={handleMouseEnterRail}
            className={`absolute top-1/2 -translate-y-1/2 cursor-pointer z-50 pointer-events-auto ${
              dockSide === "right" ? "right-0 rounded-l-full" : "left-0 rounded-r-full"
            } w-2.5 h-28 ${sliverGlowClass} transition-all duration-300 hover:w-3.5`}
          />
        )}
      </AnimatePresence>

      {/* 2. Expanded Floating Rail (曲面贴靠挂件轨道) */}
      <motion.div
        initial={false}
        animate={{
          x: isCollapsed ? (dockSide === "right" ? 70 : -70) : 0,
          opacity: isCollapsed ? 0 : 1,
        }}
        transition={{ type: "spring", stiffness: 380, damping: 28 }}
        onMouseEnter={handleMouseEnterRail}
        onMouseLeave={handleMouseLeaveRail}
        className={`absolute top-1/2 -translate-y-1/2 z-40 flex flex-col items-center py-5 px-1.5 pointer-events-auto ${
          dockSide === "right"
            ? "right-0 rounded-l-[32px] border-l border-y"
            : "left-0 rounded-r-[32px] border-r border-y"
        } ${
          isObsidian
            ? "glass-obsidian border-white/10"
            : "glass-translucent border-black/10"
        }`}
        style={{ minHeight: "220px", width: "56px" }}
      >
        {/* Top & Bottom Organic Flange Bezels (融入屏幕边缘的平滑曲面耳) */}
        <div
          className={`absolute -top-3 w-3 h-3 ${
            dockSide === "right" ? "right-0" : "left-0"
          } pointer-events-none`}
        >
          <svg viewBox="0 0 12 12" className="w-full h-full">
            <path
              d={dockSide === "right" ? "M12,0 C12,6 6,12 0,12 L12,12 Z" : "M0,0 C0,6 6,12 12,12 L0,12 Z"}
              fill={isObsidian ? "#121216" : "#f8f9fb"}
            />
          </svg>
        </div>
        <div
          className={`absolute -bottom-3 w-3 h-3 ${
            dockSide === "right" ? "right-0" : "left-0"
          } pointer-events-none`}
        >
          <svg viewBox="0 0 12 12" className="w-full h-full">
            <path
              d={dockSide === "right" ? "M12,12 C12,6 6,0 0,0 L12,0 Z" : "M0,12 C0,6 6,0 12,0 L0,0 Z"}
              fill={isObsidian ? "#121216" : "#f8f9fb"}
            />
          </svg>
        </div>

        {/* Ring Stack */}
        <div className="flex flex-col items-center space-y-3">
          {usages.map((usage) => (
            <UsageRing
              key={usage.provider_id}
              usage={usage}
              isHovered={hoveredProviderId === usage.provider_id}
              theme={theme}
              onHover={(rect) => handleRingHover(usage.provider_id, rect)}
            />
          ))}
        </div>
      </motion.div>

      {/* 3. Flyout Detail Card (悬停滑出的气泡卡片) */}
      <AnimatePresence>
        {activeUsage && !isCollapsed && (
          <UsageDetailCard
            usage={activeUsage}
            targetRect={targetRect}
            dockSide={dockSide}
            theme={theme}
            onMouseEnter={handleCardMouseEnter}
            onMouseLeave={handleCardMouseLeave}
          />
        )}
      </AnimatePresence>
    </div>
  );
};
