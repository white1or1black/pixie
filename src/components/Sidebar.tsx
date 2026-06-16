import { useState, useMemo, useEffect, useRef } from "react";
import type { ConversationEntry } from "../hooks/useChat";
import type { WorkspaceState, AgentEngineId, EngineStatus } from "../types";
import { AGENT_ENGINES } from "../types";

interface SidebarProps {
  entries: ConversationEntry[];
  workspaces: WorkspaceState[];
  workspaceFilter: string | null;
  activeId: string | null;
  generatingIds: Set<string>;
  onSelect: (id: string, workspaceId: string) => void;
  onNew: (workspaceId?: string) => void;
  onDelete: (id: string, workspaceId: string) => void;
  onAddWorkspace: () => void;
  onRemoveWorkspace: (id: string) => void;
  onSetWorkspaceFilter: (id: string | null) => void;
  onOpenSettings: () => void;
  onOpenTasks: () => void;
  onOpenSkills: () => void;
  isOpen: boolean;
  onClose: () => void;
  defaultEngine: AgentEngineId;
  onDefaultEngineChange: (engine: AgentEngineId) => void;
  engineStatuses: EngineStatus[];
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function workspaceName(workspaces: WorkspaceState[], id: string): string {
  return workspaces.find((w) => w.id === id)?.name ?? id.split("/").pop() ?? id;
}

/** Sessions updated within this window stay in the Active section. */
const ACTIVE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function isActiveEntry(entry: ConversationEntry, generatingIds: Set<string>): boolean {
  if (generatingIds.has(entry.conversation.id)) return true;
  return Date.now() - entry.conversation.updatedAt < ACTIVE_THRESHOLD_MS;
}

function sortEntries(entries: ConversationEntry[], generatingIds: Set<string>): ConversationEntry[] {
  return [...entries].sort((a, b) => {
    const aRun = generatingIds.has(a.conversation.id);
    const bRun = generatingIds.has(b.conversation.id);
    if (aRun !== bRun) return aRun ? -1 : 1;
    return b.conversation.updatedAt - a.conversation.updatedAt;
  });
}

function ConversationRow({
  entry,
  workspaceLabel,
  isActive,
  isGenerating,
  onSelect,
  onDelete,
}: {
  entry: ConversationEntry;
  workspaceLabel: string;
  isActive: boolean;
  isGenerating: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { conversation: conv } = entry;
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div
      onClick={() => { setConfirmDelete(false); onSelect(); }}
      className={`
        group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer mb-0.5
        transition-colors
        ${
          isActive
            ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
        }
      `}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {isGenerating && (
            <span className="shrink-0 w-2 h-2 rounded-full bg-green-400 animate-pulse" title="Generating..." />
          )}
          <p className="text-sm truncate leading-tight">{conv.title}</p>
        </div>
          <p className="text-[10px] mt-0.5 opacity-60 truncate">
          <span className="text-[var(--accent)]/80">{workspaceLabel}</span>
          <span className="mx-1">·</span>
          <span>{AGENT_ENGINES.find((e) => e.id === conv.engine)?.label ?? conv.engine}</span>
          <span className="mx-1">·</span>
          {relativeTime(conv.updatedAt)}
        </p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (confirmDelete) {
            onDelete();
          } else {
            setConfirmDelete(true);
            setTimeout(() => setConfirmDelete(false), 3000);
          }
        }}
        className={`shrink-0 p-1 rounded transition-all ${
          confirmDelete
            ? "bg-red-500/30 text-red-400"
            : "opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-red-400"
        }`}
        title={confirmDelete ? "Click again to confirm" : "Delete conversation"}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <path d="M4.5 2h5a.5.5 0 010 1h-5a.5.5 0 010-1zM3 4h8l-.7 8.4a1 1 0 01-1 .9H4.7a1 1 0 01-1-.9L3 4zm2.5 2v5M7 6v5M8.5 6v5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

function SectionHeader({
  label,
  count,
  expanded,
  onToggle,
  collapsible,
}: {
  label: string;
  count: number;
  expanded?: boolean;
  onToggle?: () => void;
  collapsible?: boolean;
}) {
  if (!collapsible) {
    return (
      <p className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-medium sticky top-0 bg-[var(--bg-secondary)] z-[1]">
        {label} · {count}
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-medium sticky top-0 bg-[var(--bg-secondary)] z-[1] hover:text-[var(--text-primary)] transition-colors"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
      >
        <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label} · {count}
    </button>
  );
}

function EntryList({
  entries,
  workspaces,
  activeId,
  generatingIds,
  onSelect,
  onDelete,
}: {
  entries: ConversationEntry[];
  workspaces: WorkspaceState[];
  activeId: string | null;
  generatingIds: Set<string>;
  onSelect: (id: string, workspaceId: string) => void;
  onDelete: (id: string, workspaceId: string) => void;
}) {
  return (
    <>
      {entries.map((entry) => (
        <ConversationRow
          key={entry.conversation.id}
          entry={entry}
          workspaceLabel={workspaceName(workspaces, entry.workspaceId)}
          isActive={entry.conversation.id === activeId}
          isGenerating={generatingIds.has(entry.conversation.id)}
          onSelect={() => onSelect(entry.conversation.id, entry.workspaceId)}
          onDelete={() => onDelete(entry.conversation.id, entry.workspaceId)}
        />
      ))}
    </>
  );
}

export default function Sidebar({
  entries,
  workspaces,
  workspaceFilter,
  activeId,
  generatingIds,
  onSelect,
  onNew,
  onDelete,
  onAddWorkspace,
  onRemoveWorkspace,
  onSetWorkspaceFilter,
  onOpenSettings,
  onOpenTasks,
  onOpenSkills,
  isOpen,
  onClose,
  defaultEngine,
  onDefaultEngineChange,
  engineStatuses,
}: SidebarProps) {
  const [search, setSearch] = useState("");
  const [wsPendingRemove, setWsPendingRemove] = useState<string | null>(null);
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false);
  const wsDropdownRef = useRef<HTMLDivElement>(null);

  // Close workspace dropdown on outside clicks
  useEffect(() => {
    if (!wsDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (wsDropdownRef.current && !wsDropdownRef.current.contains(e.target as Node)) {
        setWsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [wsDropdownOpen]);

  const [newAgentWsOpen, setNewAgentWsOpen] = useState(false);
  const newAgentWsRef = useRef<HTMLDivElement>(null);

  // Close new-agent workspace dropdown on outside clicks
  useEffect(() => {
    if (!newAgentWsOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (newAgentWsRef.current && !newAgentWsRef.current.contains(e.target as Node)) {
        setNewAgentWsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [newAgentWsOpen]);

  const [historyExpanded, setHistoryExpanded] = useState(false);

  const filtered = useMemo(() => {
    let list = entries;
    if (workspaceFilter) {
      list = list.filter((e) => e.workspaceId === workspaceFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (e) =>
          e.conversation.title.toLowerCase().includes(q) ||
          workspaceName(workspaces, e.workspaceId).toLowerCase().includes(q),
      );
    }
    return list;
  }, [entries, workspaceFilter, search, workspaces]);

  const { activeEntries, historyEntries } = useMemo(() => {
    const active: ConversationEntry[] = [];
    const history: ConversationEntry[] = [];
    for (const entry of filtered) {
      if (isActiveEntry(entry, generatingIds)) {
        active.push(entry);
      } else {
        history.push(entry);
      }
    }
    return {
      activeEntries: sortEntries(active, generatingIds),
      historyEntries: sortEntries(history, generatingIds),
    };
  }, [filtered, generatingIds]);

  const activeInHistory = useMemo(
    () => !!activeId && historyEntries.some((e) => e.conversation.id === activeId),
    [activeId, historyEntries],
  );

  useEffect(() => {
    if (activeInHistory) setHistoryExpanded(true);
  }, [activeInHistory]);

  const isSearching = search.trim().length > 0;
  const newAgentTargetWs = workspaceFilter ?? workspaces[0]?.id ?? null;

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={onClose} />
      )}

      <aside
        className={`
          fixed top-0 left-0 z-40 h-full w-[280px] bg-[var(--bg-secondary)] border-r border-[var(--border-color)]
          flex-col
          transition-transform duration-200 ease-out
          lg:relative
          ${isOpen ? "flex translate-x-0 sidebar-enter" : "hidden"}
        `}
      >
        {/* Workspace filter & management */}
        {workspaces.length > 0 && (
          <div className="px-3 py-2 border-b border-[var(--border-color)]">
            <div className="relative" ref={wsDropdownRef}>
              <button
                onClick={() => setWsDropdownOpen(!wsDropdownOpen)}
                className="w-full flex items-center justify-between bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors cursor-pointer"
              >
                <span className="truncate">
                  {workspaceFilter
                    ? workspaces.find((w) => w.id === workspaceFilter)?.name ?? "All workspaces"
                    : "All workspaces"}
                </span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`shrink-0 ml-2 text-[var(--text-secondary)] transition-transform duration-200 ${wsDropdownOpen ? "rotate-180" : ""}`}>
                  <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {wsDropdownOpen && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-lg overflow-hidden">
                    <button
                      onClick={() => { onSetWorkspaceFilter(null); setWsDropdownOpen(false); }}
                      className={`w-full flex items-center px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors ${
                        workspaceFilter === null ? "text-[var(--accent)] font-medium" : "text-[var(--text-primary)]"
                      }`}
                    >
                      All workspaces
                    </button>
                    {workspaces.map((ws) => (
                      <div
                        key={ws.id}
                        className={`flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors ${
                          workspaceFilter === ws.id ? "text-[var(--accent)] font-medium" : "text-[var(--text-primary)]"
                        }`}
                      >
                        <button
                          onClick={() => { onSetWorkspaceFilter(ws.id); setWsDropdownOpen(false); }}
                          className="flex-1 min-w-0 truncate text-left"
                          title={ws.path}
                        >
                          {ws.name}
                        </button>
                        <button
                          onClick={() => {
                            if (wsPendingRemove === ws.id) {
                              onRemoveWorkspace(ws.id);
                              setWsPendingRemove(null);
                              setWsDropdownOpen(false);
                            } else {
                              setWsPendingRemove(ws.id);
                              setTimeout(() => setWsPendingRemove((prev) => prev === ws.id ? null : prev), 3000);
                            }
                          }}
                          className={`shrink-0 p-0.5 rounded transition-colors ${
                            wsPendingRemove === ws.id
                              ? "bg-red-500/30 text-red-400"
                              : "hover:bg-red-500/20 text-[var(--text-secondary)] hover:text-red-400"
                          }`}
                          title={wsPendingRemove === ws.id ? "Click again to confirm" : "Remove workspace"}
                        >
                          {wsPendingRemove === ws.id ? (
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                              <path d="M2 6h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                          )}
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => { onAddWorkspace(); setWsDropdownOpen(false); }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors border-t border-[var(--border-color)]"
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M6 3v6M3 6h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      Add workspace…
                    </button>
                  </div>
              )}
            </div>
          </div>
        )}

        {/* Search */}
        <div className="px-3 py-2 border-b border-[var(--border-color)]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents…"
            className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>

        {/* Conversation list: Active + collapsible History */}
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {filtered.length === 0 && (
            <p className="text-xs text-[var(--text-secondary)] text-center mt-8 px-2">
              {search
                ? "No matching agents"
                : workspaces.length === 0
                  ? "Add a workspace to start"
                  : "No agents yet — create one below"}
            </p>
          )}

          {isSearching ? (
            <EntryList
              entries={sortEntries(filtered, generatingIds)}
              workspaces={workspaces}
              activeId={activeId}
              generatingIds={generatingIds}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ) : (
            <>
              {activeEntries.length > 0 && (
                <div className="mb-2">
                  <SectionHeader label="Active" count={activeEntries.length} />
                  <EntryList
                    entries={activeEntries}
                    workspaces={workspaces}
                    activeId={activeId}
                    generatingIds={generatingIds}
                    onSelect={onSelect}
                    onDelete={onDelete}
                  />
                </div>
              )}

              {historyEntries.length > 0 && (
                <div>
                  <SectionHeader
                    label="History"
                    count={historyEntries.length}
                    collapsible
                    expanded={historyExpanded}
                    onToggle={() => setHistoryExpanded((v) => !v)}
                  />
                  {historyExpanded && (
                    <EntryList
                      entries={historyEntries}
                      workspaces={workspaces}
                      activeId={activeId}
                      generatingIds={generatingIds}
                      onSelect={onSelect}
                      onDelete={onDelete}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Bottom bar */}
        <div className="px-3 py-2 border-t border-[var(--border-color)] space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-[var(--text-secondary)] shrink-0">Engine</label>
            <select
              value={defaultEngine}
              onChange={(e) => onDefaultEngineChange(e.target.value as AgentEngineId)}
              className="flex-1 min-w-0 text-xs rounded-lg px-2 py-1.5 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]"
              title="Default engine for new sessions"
            >
              {AGENT_ENGINES.map((e) => {
                const status = engineStatuses.find((s) => s.id === e.id);
                const suffix = status?.available ? "" : " (unavailable)";
                return (
                  <option key={e.id} value={e.id}>
                    {e.label}{suffix}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="relative flex gap-1" ref={newAgentWsRef}>
            <button
              onClick={() => onNew(newAgentTargetWs ?? undefined)}
              disabled={workspaces.length === 0}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
              New Agent
              {newAgentTargetWs && workspaces.length > 1 && (
                <span className="opacity-70 font-normal">
                  in {workspaceName(workspaces, newAgentTargetWs)}
                </span>
              )}
            </button>
            {workspaces.length > 1 && (
              <button
                onClick={() => setNewAgentWsOpen(!newAgentWsOpen)}
                disabled={workspaces.length === 0}
                className="px-2 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white transition-colors"
                title="New agent in another workspace"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`transition-transform duration-200 ${newAgentWsOpen ? "rotate-180" : ""}`}>
                  <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            {newAgentWsOpen && workspaces.length > 1 && (
              <div className="absolute bottom-full right-3 left-3 z-50 mb-1 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-lg overflow-hidden">
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    onClick={() => {
                      onNew(ws.id);
                      setNewAgentWsOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors truncate"
                  >
                    📁 {ws.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onOpenTasks}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-xs transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M7 4v3l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Scheduled Tasks
          </button>
          <button
            onClick={onOpenSkills}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-xs transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3l1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9L12 3z" />
            </svg>
            Skills
          </button>
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-xs transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 9a2 2 0 100-4 2 2 0 000 4z" stroke="currentColor" strokeWidth="1.2" fill="none" />
              <path d="M12.2 7c0-.3 0-.6-.1-.8l1.4-1.1-1.3-2.4-1.7.5c-.4-.3-.9-.6-1.4-.8L8.6.6h-2.8l-.4 1.8c-.5.2-1 .4-1.4.8l-1.7-.5-1.3 2.4 1.4 1.1c-.1.3-.1.6-.1.8s0 .6.1.8l-1.4 1.1 1.3 2.4 1.7-.5c.4.3.9.6 1.4.8l.4 1.8h2.8l.4-1.8c.5-.2 1-.4 1.4-.8l1.7.5 1.3-2.4-1.4-1.1c.1-.3.1-.6.1-.8z" stroke="currentColor" strokeWidth="1" fill="none" />
            </svg>
            Settings
          </button>
        </div>
      </aside>
    </>
  );
}
