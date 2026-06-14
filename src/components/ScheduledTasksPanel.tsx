import { useMemo, useState } from "react";
import type { ScheduledTask, ScheduleSpec, TaskRunRecord, WorkspaceState } from "../types";

interface ScheduledTasksPanelProps {
  workspaces: WorkspaceState[];
  tasks: ScheduledTask[];
  runs: TaskRunRecord[];
  onCreate: (input: {
    name: string;
    workspace: string;
    prompt: string;
    schedule: ScheduleSpec;
    enabled: boolean;
  }) => Promise<ScheduledTask | void>;
  onUpdate: (task: ScheduledTask) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onRunNow: (id: string) => Promise<void>;
  onClose: () => void;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatSchedule(s: ScheduleSpec): string {
  switch (s.type) {
    case "daily_time":
      return `Daily at ${pad(s.hour)}:${pad(s.minute)}`;
    case "weekdays_time":
      return `Weekdays at ${pad(s.hour)}:${pad(s.minute)}`;
    case "every_n_minutes":
      return `Every ${s.minutes} min`;
    case "every_n_hours":
      return `Every ${s.hours} hr${s.hours > 1 ? "s" : ""}`;
  }
}

function relativeFromIso(iso: string | null): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  const fmt = (val: number, unit: string) =>
    `${val}${unit} ${diff >= 0 ? "from now" : "ago"}`;
  if (mins < 1) return diff >= 0 ? "in a moment" : "just now";
  if (mins < 60) return fmt(mins, "m");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return fmt(hours, "h");
  const days = Math.floor(hours / 24);
  return fmt(days, "d");
}

interface Draft {
  id: string | null; // null => creating a new task
  name: string;
  workspace: string;
  prompt: string;
  scheduleType: ScheduleSpec["type"];
  hour: number;
  minute: number;
  minutes: number;
  hours: number;
  enabled: boolean;
}

function emptyDraft(defaultWorkspace: string): Draft {
  return {
    id: null,
    name: "",
    workspace: defaultWorkspace,
    prompt: "",
    scheduleType: "daily_time",
    hour: 9,
    minute: 0,
    minutes: 30,
    hours: 1,
    enabled: true,
  };
}

function taskToDraft(t: ScheduledTask): Draft {
  return {
    id: t.id,
    name: t.name,
    workspace: t.workspace,
    prompt: t.prompt,
    scheduleType: t.schedule.type,
    hour: t.schedule.type === "daily_time" || t.schedule.type === "weekdays_time" ? t.schedule.hour : 9,
    minute: t.schedule.type === "daily_time" || t.schedule.type === "weekdays_time" ? t.schedule.minute : 0,
    minutes: t.schedule.type === "every_n_minutes" ? t.schedule.minutes : 30,
    hours: t.schedule.type === "every_n_hours" ? t.schedule.hours : 1,
    enabled: t.enabled,
  };
}

function buildSpec(d: Draft): ScheduleSpec {
  switch (d.scheduleType) {
    case "daily_time":
      return { type: "daily_time", hour: d.hour, minute: d.minute };
    case "weekdays_time":
      return { type: "weekdays_time", hour: d.hour, minute: d.minute };
    case "every_n_minutes":
      return { type: "every_n_minutes", minutes: d.minutes };
    case "every_n_hours":
      return { type: "every_n_hours", hours: d.hours };
  }
}

const inputClass =
  "w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]";

export default function ScheduledTasksPanel({
  workspaces,
  tasks,
  runs,
  onCreate,
  onUpdate,
  onDelete,
  onToggle,
  onRunNow,
  onClose,
}: ScheduledTasksPanelProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const workspaceName = (path: string) =>
    workspaces.find((w) => w.path === path)?.name ??
    path.split("/").filter(Boolean).pop() ??
    path;

  // Latest-first run history, capped for display.
  const recentRuns = useMemo(
    () =>
      [...runs]
        .sort((a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at))
        .slice(0, 50),
    [runs]
  );

  const startNew = () => {
    setError(null);
    setDraft(emptyDraft(workspaces[0]?.path ?? ""));
  };

  const saveDraft = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return setError("Name is required");
    if (!draft.workspace) return setError("Pick a workspace");
    if (!draft.prompt.trim()) return setError("Prompt is required");
    const spec = buildSpec(draft);
    try {
      if (draft.id) {
        // Preserve schedule-derived runtime fields; backend recomputes next_run.
        await onUpdate({
          id: draft.id,
          name: draft.name.trim(),
          workspace: draft.workspace,
          prompt: draft.prompt.trim(),
          schedule: spec,
          enabled: draft.enabled,
          next_run: null,
          last_run: null,
        });
      } else {
        await onCreate({
          name: draft.name.trim(),
          workspace: draft.workspace,
          prompt: draft.prompt.trim(),
          schedule: spec,
          enabled: draft.enabled,
        });
      }
      setDraft(null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="settings-enter fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[var(--bg-secondary)] border-l border-[var(--border-color)] h-full overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-color)]">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            Scheduled Tasks
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <path
                d="M4 4L14 14M14 4L4 14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* New-task button */}
          {!draft && (
            <button
              onClick={startNew}
              disabled={workspaces.length === 0}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <path
                  d="M7 1v12M1 7h12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
              New Task
            </button>
          )}

          {/* Create / edit form */}
          {draft && (
            <section className="bg-[var(--bg-primary)] rounded-xl p-4 border border-[var(--border-color)] space-y-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {draft.id ? "Edit Task" : "New Task"}
              </h3>

              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  Name
                </label>
                <input
                  className={inputClass}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. Daily git summary"
                />
              </div>

              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  Workspace
                </label>
                <select
                  className={inputClass}
                  value={draft.workspace}
                  onChange={(e) => setDraft({ ...draft, workspace: e.target.value })}
                >
                  {workspaces.length === 0 && <option value="">No workspaces</option>}
                  {workspaces.map((w) => (
                    <option key={w.path} value={w.path}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  Prompt
                </label>
                <textarea
                  className={`${inputClass} resize-y min-h-[80px]`}
                  value={draft.prompt}
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                  placeholder="The instruction the AI runs on schedule"
                />
              </div>

              <div>
                <label className="block text-xs text-[var(--text-secondary)] mb-1">
                  Schedule
                </label>
                <select
                  className={inputClass}
                  value={draft.scheduleType}
                  onChange={(e) =>
                    setDraft({ ...draft, scheduleType: e.target.value as ScheduleSpec["type"] })
                  }
                >
                  <option value="daily_time">Daily at a time</option>
                  <option value="weekdays_time">Weekdays at a time</option>
                  <option value="every_n_minutes">Every N minutes</option>
                  <option value="every_n_hours">Every N hours</option>
                </select>
              </div>

              {(draft.scheduleType === "daily_time" ||
                draft.scheduleType === "weekdays_time") && (
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1">
                    Time (24h, local)
                  </label>
                  <input
                    type="time"
                    className={inputClass}
                    value={`${pad(draft.hour)}:${pad(draft.minute)}`}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map((n) => parseInt(n, 10));
                      setDraft({
                        ...draft,
                        hour: Number.isNaN(h) ? draft.hour : h,
                        minute: Number.isNaN(m) ? draft.minute : m,
                      });
                    }}
                  />
                </div>
              )}

              {draft.scheduleType === "every_n_minutes" && (
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1">
                    Every N minutes
                  </label>
                  <input
                    type="number"
                    min={1}
                    className={inputClass}
                    value={draft.minutes}
                    onChange={(e) =>
                      setDraft({ ...draft, minutes: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                </div>
              )}

              {draft.scheduleType === "every_n_hours" && (
                <div>
                  <label className="block text-xs text-[var(--text-secondary)] mb-1">
                    Every N hours
                  </label>
                  <input
                    type="number"
                    min={1}
                    className={inputClass}
                    value={draft.hours}
                    onChange={(e) =>
                      setDraft({ ...draft, hours: Math.max(1, Number(e.target.value) || 1) })
                    }
                  />
                </div>
              )}

              <label className="flex items-center gap-2 text-sm text-[var(--text-primary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  className="accent-[var(--accent)]"
                />
                Enabled
              </label>

              {error && <p className="text-xs text-red-400">{error}</p>}

              <div className="flex gap-2 pt-1">
                <button
                  onClick={saveDraft}
                  className="flex-1 px-3 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors"
                >
                  {draft.id ? "Save" : "Create"}
                </button>
                <button
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                  className="px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] hover:opacity-80 text-[var(--text-primary)] text-xs font-medium transition-colors"
                >
                  Cancel
                </button>
              </div>
            </section>
          )}

          {/* Task list */}
          <section className="space-y-2">
            {tasks.length === 0 && !draft && (
              <p className="text-xs text-[var(--text-secondary)] text-center py-4">
                No scheduled tasks yet.
              </p>
            )}
            {tasks.map((t) => {
              const wsMissing = !workspaces.some((w) => w.path === t.workspace);
              return (
                <div
                  key={t.id}
                  className="bg-[var(--bg-primary)] rounded-xl p-3 border border-[var(--border-color)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                          {t.name}
                        </span>
                        {!t.enabled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                            paused
                          </span>
                        )}
                      </div>
                      <p
                        className={`text-xs truncate ${
                          wsMissing ? "text-red-400" : "text-[var(--text-secondary)]"
                        }`}
                        title={t.workspace}
                      >
                        {wsMissing ? "⚠ missing: " : ""}
                        {workspaceName(t.workspace)}
                      </p>
                    </div>
                    <button
                      onClick={() => onToggle(t.id, !t.enabled)}
                      title={t.enabled ? "Disable" : "Enable"}
                      className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                        t.enabled ? "bg-[var(--accent)]" : "bg-[var(--bg-tertiary)]"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                          t.enabled ? "left-4" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">
                    <span>⏱ {formatSchedule(t.schedule)}</span>
                    <span>next: {relativeFromIso(t.next_run)}</span>
                    <span>last: {relativeFromIso(t.last_run)}</span>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={() => onRunNow(t.id)}
                      className="px-2.5 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--accent)]/20 text-[11px] text-[var(--text-primary)] transition-colors"
                    >
                      Run now
                    </button>
                    <button
                      onClick={() => {
                        setError(null);
                        setDraft(taskToDraft(t));
                      }}
                      className="px-2.5 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:opacity-80 text-[11px] text-[var(--text-primary)] transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete task "${t.name}"?`)) onDelete(t.id);
                      }}
                      className="px-2.5 py-1 rounded-lg bg-[var(--bg-tertiary)] hover:bg-red-500/20 hover:text-red-300 text-[11px] text-[var(--text-secondary)] transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </section>

          {/* Recent runs */}
          {recentRuns.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                Recent Runs
              </h3>
              <div className="space-y-2">
                {recentRuns.map((r) => (
                  <div
                    key={r.id}
                    className="bg-[var(--bg-primary)] rounded-xl p-3 border border-[var(--border-color)]"
                  >
                    <button
                      onClick={() =>
                        setExpandedRun(expandedRun === r.id ? null : r.id)
                      }
                      className="w-full flex items-center justify-between gap-2 text-left"
                    >
                      <span className="text-sm text-[var(--text-primary)] truncate">
                        {r.task_name}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                          r.status === "ok"
                            ? "bg-green-500/15 text-green-400"
                            : "bg-red-500/15 text-red-400"
                        }`}
                      >
                        {r.status}
                      </span>
                    </button>
                    <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
                      {relativeFromIso(r.finished_at)} · {workspaceName(r.workspace)}
                    </div>
                    {expandedRun === r.id && (
                      <div className="mt-2 space-y-2 text-xs">
                        <div>
                          <div className="text-[var(--text-secondary)] mb-0.5">Prompt</div>
                          <div className="whitespace-pre-wrap text-[var(--text-primary)] bg-[var(--bg-tertiary)]/40 rounded p-2">
                            {r.prompt}
                          </div>
                        </div>
                        <div>
                          <div className="text-[var(--text-secondary)] mb-0.5">Result</div>
                          <div className="whitespace-pre-wrap text-[var(--text-primary)] bg-[var(--bg-tertiary)]/40 rounded p-2 max-h-64 overflow-y-auto">
                            {r.result || (r.status === "error" ? "(failed)" : "(no output)")}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
