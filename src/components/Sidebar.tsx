import { useState, useMemo } from "react";
import type { Conversation, WorkspaceState } from "../types";

interface SidebarProps {
  conversations: Conversation[];
  workspaces: WorkspaceState[];
  activeWorkspaceId: string | null;
  activeId: string | null;
  generatingIds: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onAddWorkspace: () => void;
  onRemoveWorkspace: (id: string) => void;
  onSwitchWorkspace: (id: string) => void;
  onOpenSettings: () => void;
  onOpenTasks: () => void;
  isOpen: boolean;
  onClose: () => void;
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

export default function Sidebar({
  conversations,
  workspaces,
  activeWorkspaceId,
  activeId,
  generatingIds,
  onSelect,
  onNew,
  onDelete,
  onAddWorkspace,
  onRemoveWorkspace,
  onSwitchWorkspace,
  onOpenSettings,
  onOpenTasks,
  isOpen,
  onClose,
}: SidebarProps) {
  const [search, setSearch] = useState("");
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  const filtered = useMemo(() => {
    if (!search.trim()) return conversations;
    const q = search.toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, search]);

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={onClose} />
      )}

      {/* Sidebar panel */}
      <aside
        className={`
          fixed top-0 left-0 z-40 h-full w-[280px] bg-[var(--bg-secondary)] border-r border-[var(--border-color)]
          flex-col
          transition-transform duration-200 ease-out
          lg:relative
          ${isOpen ? "flex translate-x-0 sidebar-enter" : "hidden"}
        `}
      >
        {/* Workspace selector */}
        <div className="px-3 py-2 border-b border-[var(--border-color)]">
          <div className="relative">
            <button
              onClick={() => setWsDropdownOpen(!wsDropdownOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] hover:opacity-90 text-[var(--text-primary)] text-sm transition-colors"
            >
              <span className="text-base shrink-0">📁</span>
              <span className="flex-1 truncate text-left">
                {activeWorkspace?.name ?? "No workspace"}
              </span>
              <svg
                width="12" height="12" viewBox="0 0 12 12" fill="none"
                className={`transition-transform ${wsDropdownOpen ? "rotate-180" : ""}`}
              >
                <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {wsDropdownOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setWsDropdownOpen(false)} />
                <div className="absolute top-full left-0 right-0 z-20 mt-1 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg shadow-lg overflow-hidden">
                  {workspaces.map((ws) => (
                    <div
                      key={ws.id}
                      className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                        ws.id === activeWorkspaceId
                          ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                          : "text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                      }`}
                    >
                      <span
                        className="flex-1 truncate"
                        onClick={() => {
                          onSwitchWorkspace(ws.id);
                          setWsDropdownOpen(false);
                        }}
                      >
                        📁 {ws.name}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveWorkspace(ws.id);
                          if (workspaces.length <= 1) setWsDropdownOpen(false);
                        }}
                        className="shrink-0 p-0.5 rounded hover:bg-red-500/20 text-red-400 transition-colors"
                        title="Remove workspace"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => { onAddWorkspace(); setWsDropdownOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors border-t border-[var(--border-color)]"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    Add workspace
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="w-full bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 text-xs text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {filtered.length === 0 && (
            <p className="text-xs text-[var(--text-secondary)] text-center mt-8">
              {search ? "No matching conversations" : activeWorkspace ? "No conversations yet" : "Add a workspace to start"}
            </p>
          )}
          {filtered.map((conv) => (
            <div
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={`
                group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer mb-0.5
                transition-colors
                ${
                  conv.id === activeId
                    ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
                }
              `}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {generatingIds.has(conv.id) && (
                    <span className="shrink-0 w-2 h-2 rounded-full bg-green-400 animate-pulse" title="Generating..." />
                  )}
                  <p className="text-sm truncate leading-tight">{conv.title}</p>
                </div>
                <p className="text-[10px] mt-0.5 opacity-60">
                  {relativeTime(conv.updatedAt)}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(conv.id);
                }}
                className="opacity-0 group-hover:opacity-100 shrink-0 p-1 rounded hover:bg-red-500/20 text-red-400 transition-opacity"
                title="Delete conversation"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M4.5 2h5a.5.5 0 010 1h-5a.5.5 0 010-1zM3 4h8l-.7 8.4a1 1 0 01-1 .9H4.7a1 1 0 01-1-.9L3 4zm2.5 2v5M7 6v5M8.5 6v5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {/* Bottom bar: New chat + Settings */}
        <div className="px-3 py-2 border-t border-[var(--border-color)] space-y-1.5">
          <button
            onClick={onNew}
            disabled={!activeWorkspaceId}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
            </svg>
            New Chat
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
        </div>
      </aside>
    </>
  );
}