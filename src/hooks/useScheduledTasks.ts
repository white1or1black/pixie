import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ScheduledTask, TaskRunRecord } from "../types";

/**
 * Thin hook over the scheduled-task Tauri commands. Loads tasks + run history on
 * mount, refreshes when the window regains focus (a task may have fired while the
 * app was minimized to the tray) and whenever a `task-run-complete` event arrives.
 *
 * Run injection (surfacing a run as a conversation) is intentionally left to the
 * caller via the returned `runs` array — keeps this hook focused on CRUD.
 */
export function useScheduledTasks() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<TaskRunRecord[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([
        invoke<ScheduledTask[]>("list_scheduled_tasks"),
        invoke<TaskRunRecord[]>("list_task_runs"),
      ]);
      setTasks(t);
      setRuns(r);
    } catch (e) {
      console.error("useScheduledTasks load failed", e);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(t);
  }, [refresh]);

  // Refresh on focus: the scheduler can fire while the window is hidden in the tray.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Live refresh when a scheduled run completes.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ task_id: string }>("task-run-complete", () => refresh()).then(
      (u) => (un = u)
    );
    return () => {
      un?.();
    };
  }, [refresh]);

  const create = useCallback(
    async (input: {
      name: string;
      workspace: string;
      prompt: string;
      schedule: ScheduledTask["schedule"];
      enabled: boolean;
    }) => {
      const task = await invoke<ScheduledTask>("create_scheduled_task", {
        task: { id: "", next_run: null, last_run: null, ...input },
      });
      await refresh();
      return task;
    },
    [refresh]
  );

  const update = useCallback(
    async (task: ScheduledTask) => {
      await invoke<void>("update_scheduled_task", { task });
      await refresh();
    },
    [refresh]
  );

  const remove = useCallback(
    async (taskId: string) => {
      await invoke<void>("delete_scheduled_task", { taskId });
      await refresh();
    },
    [refresh]
  );

  const toggle = useCallback(
    async (taskId: string, enabled: boolean) => {
      await invoke<void>("toggle_scheduled_task", { taskId, enabled });
      await refresh();
    },
    [refresh]
  );

  const runNow = useCallback(async (taskId: string) => {
    // Manual run does not advance the schedule. Returns the conversation_id the
    // backend generated for the run, so the caller can surface a placeholder
    // session immediately (it becomes the completed run's id).
    return await invoke<string>("run_scheduled_task_now", { taskId });
  }, []);

  return { tasks, runs, refresh, create, update, remove, toggle, runNow };
}
