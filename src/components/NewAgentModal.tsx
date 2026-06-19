import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentEngineId, EngineModelConfigs, ModelEntry, WorkspaceState } from "../types";
import { AGENT_ENGINES, ENGINE_MODEL_ENV_KEY } from "../types";
import EngineBadge from "./EngineBadge";

function workspaceLabel(workspaces: WorkspaceState[], id: string): string {
  return workspaces.find((w) => w.id === id)?.name ?? id.split("/").pop() ?? id;
}

export default function NewAgentModal({
  workspaces,
  defaultWorkspaceId,
  defaultEngine,
  engineModelConfigs,
  readyEngineIds,
  onDefaultEngineChange,
  onCreate,
  onClose,
}: {
  workspaces: WorkspaceState[];
  defaultWorkspaceId: string | null;
  defaultEngine: AgentEngineId;
  engineModelConfigs: EngineModelConfigs;
  /** Engines that are installed + ready; the picker is limited to these. */
  readyEngineIds: AgentEngineId[];
  onDefaultEngineChange: (engine: AgentEngineId) => void;
  onCreate: (opts: { workspaceId: string; engine: AgentEngineId; model?: string }) => void;
  onClose: () => void;
}) {
  // Only ready engines can be used — a not-ready (not installed / not logged in)
  // engine is excluded from the picker entirely.
  const availableEngines = useMemo(
    () => AGENT_ENGINES.filter((e) => readyEngineIds.includes(e.id)),
    [readyEngineIds],
  );

  const firstAvailableEngine = availableEngines[0]?.id ?? defaultEngine;
  const firstWorkspace = workspaces[0]?.id ?? "";

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    () => defaultWorkspaceId ?? firstWorkspace
  );
  const [selectedEngine, setSelectedEngine] = useState<AgentEngineId>(() => {
    const isDefaultReady = readyEngineIds.includes(defaultEngine);
    return isDefaultReady ? defaultEngine : firstAvailableEngine;
  });
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [setAsDefaultEngine, setSetAsDefaultEngine] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelWrapperRef = useRef<HTMLDivElement>(null);
  const modelDropdownListRef = useRef<HTMLDivElement>(null);
  const modelReqSeqRef = useRef(0);
  const modelsCacheRef = useRef<Record<string, ModelEntry[]>>({});

  const fetchModels = useCallback((engine: AgentEngineId) => {
    const seq = ++modelReqSeqRef.current;
    setModelsLoading(true);
    setAvailableModels(modelsCacheRef.current[engine] ?? []);
    invoke<ModelEntry[]>("list_models", { engine })
      .then((models) => {
        if (seq !== modelReqSeqRef.current) return; // stale response
        const seen = new Set<string>();
        const deduped: ModelEntry[] = [];
        for (const m of models) {
          const id = (m.id ?? "").trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          deduped.push({ ...m, id });
        }
        modelsCacheRef.current[engine] = deduped;
        setAvailableModels(deduped);
        setModelsLoading(false);
      })
      .catch(() => {
        if (seq !== modelReqSeqRef.current) return; // stale response
        setAvailableModels([]);
        setModelsLoading(false);
      });
  }, []);

  // Invalidate any in-flight request on unmount.
  useEffect(() => {
    return () => {
      modelReqSeqRef.current += 1;
    };
  }, []);

  // Close the model dropdown when clicking outside of it.
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (modelWrapperRef.current && !modelWrapperRef.current.contains(target)) {
        setModelDropdownOpen(false);
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("pointerdown", onDown);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [modelDropdownOpen]);

  // Ensure the model dropdown always opens scrolled to the top.
  useEffect(() => {
    if (!modelDropdownOpen) return;
    requestAnimationFrame(() => {
      modelDropdownListRef.current?.scrollTo({ top: 0 });
    });
  }, [modelDropdownOpen]);

  // Load models on mount / engine change (async to satisfy lint rule).
  useEffect(() => {
    const t = window.setTimeout(() => fetchModels(selectedEngine), 0);
    return () => window.clearTimeout(t);
  }, [selectedEngine, fetchModels]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const wsLabel = selectedWorkspaceId ? workspaceLabel(workspaces, selectedWorkspaceId) : "";
  const modelSummary =
    selectedModel === "__custom__"
      ? (customModel.trim() || "Custom")
      : (selectedModel || "");

  const defaultModelFromConfig = (() => {
    const cfg = engineModelConfigs[selectedEngine] as Record<string, string | undefined>;
    return cfg?.[ENGINE_MODEL_ENV_KEY[selectedEngine]];
  })();

  const defaultModelLabel = (() => {
    const configured = typeof defaultModelFromConfig === "string" ? defaultModelFromConfig.trim() : "";
    const fallback = availableModels[0]?.id;
    const id = (configured || undefined) ?? fallback;
    if (!id) return "Auto";
    return availableModels.find((m) => m.id === id)?.label ?? id;
  })();

  const handleSelectModel = useCallback((modelId: string | undefined) => {
    if (modelId === "__custom__") {
      setSelectedModel("__custom__");
      setModelDropdownOpen(false);
      return;
    }
    setSelectedModel(modelId);
    if (modelId !== "__custom__") setCustomModel("");
    setModelDropdownOpen(false);
  }, []);

  const canCreate = !!selectedWorkspaceId && !!selectedEngine;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl shadow-xl overflow-visible"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--border-color)] flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--text-primary)]">New Agent</div>
            <div className="text-[10px] text-[var(--text-secondary)] truncate" title={selectedWorkspaceId}>
              <EngineBadge engine={selectedEngine} />
              <span className="mx-1">·</span>
              {wsLabel}
              {modelSummary ? (
                <>
                  <span className="mx-1">·</span>
                  <span className="text-[var(--accent)]/80">{modelSummary}</span>
                </>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="p-1 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            onClick={onClose}
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 12 12" fill="none">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-medium">Workspace</div>
            <select
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="w-full text-xs rounded-lg px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]"
              title={selectedWorkspaceId}
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name}
                </option>
              ))}
            </select>
            {selectedWorkspaceId && (
              <div className="text-[10px] text-[var(--text-secondary)] truncate" title={selectedWorkspaceId}>
                {selectedWorkspaceId}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-medium">Engine</div>
            <select
              value={selectedEngine}
              onChange={(e) => {
                const next = e.target.value as AgentEngineId;
                // Clear old models immediately so we don't show stale options while loading.
                setModelsLoading(true);
                setAvailableModels(modelsCacheRef.current[next] ?? []);
                setModelDropdownOpen(false);
                setSelectedEngine(next);
                setSelectedModel(undefined);
                setCustomModel("");
              }}
              className="w-full text-xs rounded-lg px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)]"
            >
              {availableEngines.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>

            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] select-none">
              <input
                type="checkbox"
                checked={setAsDefaultEngine}
                onChange={(e) => setSetAsDefaultEngine(e.target.checked)}
              />
              Set as default engine
            </label>
          </div>

          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)] font-medium">Model (optional)</div>
            <div ref={modelWrapperRef} className="relative">
              <button
                type="button"
                onClick={() => {
                  setModelDropdownOpen((v) => !v);
                }}
                className="w-full text-left text-xs rounded-lg px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] hover:border-[var(--accent)]/60 transition-colors"
                title="Select model"
              >
                {selectedModel === "__custom__"
                  ? (customModel.trim() || "Custom")
                  : selectedModel
                    ? (availableModels.find((m) => m.id === selectedModel)?.label ?? selectedModel)
                    : defaultModelLabel}
                {modelsLoading && <span className="ml-2 text-[10px] text-[var(--text-secondary)]">Loading…</span>}
              </button>

              {modelDropdownOpen && (
                <div
                  ref={modelDropdownListRef}
                  className="absolute bottom-full left-0 mb-1 w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-lg z-50 py-1 max-h-[50vh] overflow-y-auto"
                >
                  <button
                    type="button"
                    onClick={() => handleSelectModel(undefined)}
                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] transition-colors ${
                      !selectedModel ? "text-[var(--accent)] font-medium" : "text-[var(--text-primary)]"
                    }`}
                  >
                    {defaultModelLabel} (auto)
                  </button>

                  {modelsLoading && (
                    <div className="px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                      Loading models…
                    </div>
                  )}

                  {!modelsLoading && availableModels.length === 0 && (
                    <div className="px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                      No models found
                    </div>
                  )}

                  {availableModels.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleSelectModel(m.id)}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] transition-colors ${
                        selectedModel === m.id ? "text-[var(--accent)] font-medium" : "text-[var(--text-primary)]"
                      }`}
                    >
                      {m.label}
                      {m.id !== m.label && <span className="ml-1.5 text-[var(--text-secondary)] opacity-60">{m.id}</span>}
                    </button>
                  ))}

                  <div className="border-t border-[var(--border-color)] mt-1 pt-1 px-2">
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && customModel.trim()) {
                            e.preventDefault();
                            setSelectedModel("__custom__");
                            setModelDropdownOpen(false);
                          }
                        }}
                        placeholder="Custom model..."
                        className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded px-2 py-1 text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]/50 outline-none focus:border-[var(--accent)]"
                      />
                      {customModel.trim() && (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedModel("__custom__");
                            setModelDropdownOpen(false);
                          }}
                          className="text-[10px] text-[var(--accent)] hover:underline shrink-0"
                        >
                          Apply
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="text-[10px] text-[var(--text-secondary)]">
              You can also change the model later from the composer.
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-[var(--border-color)] flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-xs hover:opacity-90 transition-opacity"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={() => {
              const model =
                selectedModel === "__custom__"
                  ? customModel.trim() || undefined
                  : selectedModel || undefined;
              if (setAsDefaultEngine) onDefaultEngineChange(selectedEngine);
              onCreate({ workspaceId: selectedWorkspaceId, engine: selectedEngine, model });
              onClose();
            }}
            className="px-3 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

