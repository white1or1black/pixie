import { useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Returns a mousedown handler that starts window dragging when the user
 * clicks on empty (non-interactive) areas of the target element.
 * Double-clicking toggles window maximize/zoom.
 *
 * Usage:
 *   <header onMouseDown={useDragRegion()}>
 *     <button>click me</button>       ← still clickable
 *     <div className="flex-1" />       ← drag to move window
 *   </header>
 */
export function useDragRegion() {
  const dragging = useRef(false);
  const lastClickTime = useRef(0);

  return useCallback((e: React.MouseEvent) => {
    // Only left button
    if (e.button !== 0) return;
    // Don't drag if clicking on interactive elements
    const target = e.target as HTMLElement;
    if (
      target.closest("button, a, input, select, textarea, [role='button']") ||
      target.dataset.tauriDragRegion === "false"
    ) {
      return;
    }

    const now = Date.now();
    const isDoubleClick = now - lastClickTime.current < 400;
    lastClickTime.current = now;

    if (isDoubleClick) {
      // Reset to avoid triple-click being treated as another double-click
      lastClickTime.current = 0;
      const appWindow = getCurrentWindow();
      appWindow.toggleMaximize();
      return;
    }

    e.preventDefault();
    const appWindow = getCurrentWindow();
    dragging.current = true;
    appWindow.startDragging().finally(() => {
      dragging.current = false;
    });
  }, []);
}
