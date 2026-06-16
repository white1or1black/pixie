import { useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Returns a mousedown handler that starts window dragging when the user
 * clicks on empty (non-interactive) areas of the target element.
 *
 * Usage:
 *   <header onMouseDown={useDragRegion()}>
 *     <button>click me</button>       ← still clickable
 *     <div className="flex-1" />       ← drag to move window
 *   </header>
 */
export function useDragRegion() {
  const dragging = useRef(false);

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

    e.preventDefault();
    const appWindow = getCurrentWindow();
    dragging.current = true;
    appWindow.startDragging().finally(() => {
      dragging.current = false;
    });
  }, []);
}
