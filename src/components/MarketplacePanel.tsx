import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MarketplaceInfo, PluginCatalog, PluginInfo } from "../types";
import { useDragRegion } from "../hooks/useDragRegion";

interface MarketplacePanelProps {
  onClose: () => void;
  /** Called after install/uninstall so App can refresh the ✨ skills dropdown. */
  onSkillsChanged: () => void;
}

/** Seed marketplaces shown as tabs. Keyed by repo so "added" state is stable
 *  even when the marketplace's declared `name` differs from its repo. */
const SUGGESTED: { repo: string; label: string }[] = [
  { repo: "anthropics/claude-plugins-official", label: "Official" },
  { repo: "anthropics/knowledge-work-plugins", label: "Knowledge Work" },
  { repo: "jeremylongshore/claude-code-plugins-plus-skills", label: "Plus Skills" },
  { repo: "ComposioHQ/awesome-claude-skills", label: "ComposioHQ" },
];

const CUSTOM_TAB = "__add_custom__";
const INSTALLED_TAB = "__installed__";

function formatCount(n?: number): string {
  if (!n) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k installs`;
  return `${n} installs`;
}

export default function MarketplacePanel({ onClose, onSkillsChanged }: MarketplacePanelProps) {
  const handleDragRegion = useDragRegion();
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [catalog, setCatalog] = useState<PluginCatalog>({ installed: [], available: [] });
  const [activeRepo, setActiveRepo] = useState<string>(SUGGESTED[0].repo);
  const [query, setQuery] = useState("");
  const [customSource, setCustomSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Action key of the in-flight operation, to disable overlapping actions. */
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [ml, av] = await Promise.all([
        invoke<string>("plugin_marketplace_list"),
        invoke<string>("plugin_available"),
      ]);
      let parsedList: MarketplaceInfo[] = [];
      let parsedCatalog: PluginCatalog = { installed: [], available: [] };
      try {
        const a = JSON.parse(ml);
        if (Array.isArray(a)) parsedList = a;
      } catch { /* ignore */ }
      try {
        const c = JSON.parse(av);
        if (c && Array.isArray(c.available)) parsedCatalog = c;
      } catch { /* ignore */ }
      setMarketplaces(parsedList);
      setCatalog(parsedCatalog);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial load of marketplaces + catalog. Data fetching on mount is a
    // legitimate effect use; reload() also runs after each mutating action.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  const addedRepos = useMemo(() => new Set(marketplaces.map((m) => m.repo)), [marketplaces]);

  // Tabs = suggested + any custom-added marketplaces not in the suggested list.
  const tabs = useMemo(() => {
    const custom = marketplaces
      .filter((m) => !SUGGESTED.some((s) => s.repo === m.repo))
      .map((m) => ({ repo: m.repo, label: m.name }));
    return [...SUGGESTED, ...custom];
  }, [marketplaces]);

  // Keep activeRepo valid as tabs change (e.g. after a remove).
  if (
    activeRepo !== INSTALLED_TAB &&
    activeRepo !== CUSTOM_TAB &&
    !tabs.some((t) => t.repo === activeRepo)
  ) {
    setActiveRepo(tabs[0]?.repo ?? CUSTOM_TAB);
  }

  const activeMarketplace = marketplaces.find((m) => m.repo === activeRepo);
  const activeName = activeMarketplace?.name;
  const isActiveAdded = activeMarketplace !== undefined;

  const installedIds = useMemo(
    () => new Set(catalog.installed.map((p) => p.pluginId)),
    [catalog.installed],
  );

  const plugins = useMemo(() => {
    if (!activeName) return [];
    return catalog.available
      .filter((p) => p.marketplaceName === activeName)
      .sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0));
  }, [catalog.available, activeName]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q),
    );
  }, [plugins, query]);

  const addMarketplace = useCallback(
    async (source: string) => {
      const key = `add:${source}`;
      setBusy(key);
      setError(null);
      try {
        await invoke("plugin_marketplace_add", { source, scope: null });
        await reload();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const removeMarketplace = useCallback(
    async (name: string) => {
      const key = `remove:${name}`;
      setBusy(key);
      setError(null);
      try {
        await invoke("plugin_marketplace_remove", { name });
        await reload();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const install = useCallback(
    async (plugin: PluginInfo) => {
      const key = `install:${plugin.pluginId}`;
      setBusy(key);
      setError(null);
      try {
        await invoke("plugin_install", { pluginId: plugin.pluginId });
        await reload();
        onSkillsChanged();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [reload, onSkillsChanged],
  );

  const uninstall = useCallback(
    async (plugin: PluginInfo) => {
      const key = `uninstall:${plugin.name}`;
      setBusy(key);
      setError(null);
      try {
        await invoke("plugin_uninstall", { name: plugin.name });
        await reload();
        onSkillsChanged();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [reload, onSkillsChanged],
  );

  const handleAddCustom = () => {
    const src = customSource.trim();
    if (!src) return;
    void addMarketplace(src);
    setCustomSource("");
  };

  return (
    <div className="settings-enter flex flex-col flex-1 min-h-0 bg-[var(--bg-primary)] overflow-hidden">
        {/* Header — drag empty areas to move window */}
        <div
          onMouseDown={handleDragRegion}
          className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]"
        >
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Skills Marketplace</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
            title="Close"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="shrink-0 flex items-center gap-1 px-2 border-b border-[var(--border-color)] overflow-x-auto">
          <button
            onClick={() => setActiveRepo(INSTALLED_TAB)}
            className={`shrink-0 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeRepo === INSTALLED_TAB
                ? "border-[var(--accent)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            Installed
            {catalog.installed.length > 0 && (
              <span className="ml-1.5 inline-block min-w-4 px-1 text-center text-[10px] rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] align-middle">
                {catalog.installed.length}
              </span>
            )}
          </button>
          {tabs.map((t) => {
            const added = addedRepos.has(t.repo);
            const isActive = activeRepo === t.repo;
            return (
              <button
                key={t.repo}
                onClick={() => setActiveRepo(t.repo)}
                className={`shrink-0 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                  isActive
                    ? "border-[var(--accent)] text-[var(--text-primary)]"
                    : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {t.label}
                {added ? (
                  <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-[var(--accent)] align-middle" />
                ) : null}
              </button>
            );
          })}
          <button
            onClick={() => setActiveRepo(CUSTOM_TAB)}
            className={`shrink-0 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeRepo === CUSTOM_TAB
                ? "border-[var(--accent)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
            title="Add a custom marketplace"
          >
            +
          </button>
        </div>

        {error && (
          <div className="shrink-0 px-4 py-2 bg-red-900/30 border-b border-red-800/50 text-red-300 text-xs flex items-start justify-between gap-3">
            <span className="break-words">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 text-red-400 hover:text-red-200">
              Dismiss
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {activeRepo === INSTALLED_TAB ? (
            <div className="flex flex-col h-full">
              {catalog.installed.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-[var(--text-secondary)]">
                  No skills installed
                </div>
              ) : (
                catalog.installed.map((p) => (
                  <div
                    key={p.pluginId}
                    className="px-4 py-2.5 border-b border-[var(--border-color)] flex items-start gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                          {p.name}
                        </span>
                        {p.version && (
                          <span className="text-[10px] text-[var(--text-secondary)] opacity-70">
                            v{p.version}
                          </span>
                        )}
                      </div>
                      {p.description && (
                        <p className="text-xs text-[var(--text-secondary)] mt-0.5 line-clamp-2">
                          {p.description}
                        </p>
                      )}
                      {p.marketplaceName && (
                        <p className="text-[10px] text-[var(--text-secondary)] opacity-60 mt-0.5">
                          {p.marketplaceName}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => uninstall(p)}
                      disabled={busy !== null}
                      className="shrink-0 px-3 py-1.5 rounded-lg text-xs bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:text-red-400 disabled:opacity-50 transition-colors"
                    >
                      {busy === `uninstall:${p.name}` ? "…" : "Uninstall"}
                    </button>
                  </div>
                ))
              )}
            </div>
          ) : activeRepo === CUSTOM_TAB ? (
            <div className="p-6">
              <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">
                Add a custom marketplace
              </h3>
              <p className="text-xs text-[var(--text-secondary)] mb-4">
                Enter a GitHub <code className="text-[var(--text-primary)]">owner/repo</code>, a git
                URL, or a local path. The repo must contain
                <code className="text-[var(--text-primary)]"> .claude-plugin/marketplace.json</code>.
              </p>
              <div className="flex gap-2">
                <input
                  value={customSource}
                  onChange={(e) => setCustomSource(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddCustom();
                  }}
                  placeholder="e.g. travisvn/awesome-claude-skills"
                  className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none focus:border-[var(--accent)]"
                />
                <button
                  onClick={handleAddCustom}
                  disabled={!customSource.trim() || busy !== null}
                  className="px-4 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                >
                  Add
                </button>
              </div>
            </div>
          ) : !isActiveAdded ? (
            <div className="flex flex-col items-center justify-center h-full px-6 text-center">
              <p className="text-sm text-[var(--text-secondary)] mb-4">
                This marketplace is not added yet. Add it to browse and install its skills.
                {activeRepo === "jeremylongshore/claude-code-plugins-plus-skills" && (
                  <span className="block mt-1 text-xs">Large repo — this may take a minute.</span>
                )}
              </p>
              <button
                onClick={() => addMarketplace(activeRepo)}
                disabled={busy !== null}
                className="px-4 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                {busy === `add:${activeRepo}` ? "Adding…" : "Add marketplace"}
              </button>
            </div>
          ) : (
            <div className="flex flex-col h-full">
              {/* Toolbar */}
              <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--border-color)]">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Filter ${plugins.length} plugins…`}
                  className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none focus:border-[var(--accent)]"
                />
                <button
                  onClick={() => activeMarketplace && removeMarketplace(activeMarketplace.name)}
                  disabled={busy !== null}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-red-400 disabled:opacity-40 transition-colors"
                  title="Remove this marketplace"
                >
                  {busy === `remove:${activeMarketplace?.name}` ? "Removing…" : "Remove"}
                </button>
              </div>

              {/* List */}
              <div className="flex-1 overflow-y-auto">
                {loading ? (
                  <div className="px-4 py-8 text-center text-xs text-[var(--text-secondary)]">
                    Loading…
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-[var(--text-secondary)]">
                    {query ? "No plugins match your filter" : "No plugins in this marketplace"}
                  </div>
                ) : (
                  filtered.map((p) => {
                    const installed = installedIds.has(p.pluginId);
                    return (
                      <div
                        key={p.pluginId}
                        className="px-4 py-2.5 border-b border-[var(--border-color)] flex items-start gap-3"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                              {p.name}
                            </span>
                            {p.version && (
                              <span className="text-[10px] text-[var(--text-secondary)] opacity-70">
                                v{p.version}
                              </span>
                            )}
                          </div>
                          {p.description && (
                            <p className="text-xs text-[var(--text-secondary)] mt-0.5 line-clamp-2">
                              {p.description}
                            </p>
                          )}
                          <p className="text-[10px] text-[var(--text-secondary)] opacity-60 mt-0.5">
                            {formatCount(p.installCount)}
                          </p>
                        </div>
                        {installed ? (
                          <button
                            onClick={() => uninstall(p)}
                            disabled={busy !== null}
                            className="shrink-0 px-3 py-1.5 rounded-lg text-xs bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:text-red-400 disabled:opacity-50 transition-colors"
                          >
                            {busy === `uninstall:${p.name}` ? "…" : "Uninstall"}
                          </button>
                        ) : (
                          <button
                            onClick={() => install(p)}
                            disabled={busy !== null}
                            className="shrink-0 px-3 py-1.5 rounded-lg text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 text-white transition-colors"
                          >
                            {busy === `install:${p.pluginId}` ? "…" : "Install"}
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
    </div>
  );
}
