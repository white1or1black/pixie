import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillEntry } from "../types";

interface SkillsDropdownProps {
  skills: SkillEntry[];
  onSelect: (skill: SkillEntry) => void;
  onClose: () => void;
}

/**
 * Filterable, keyboard-navigable list of available agent skills (Claude skills standard).
 *
 * The flat selection index runs over `filtered` in display order (project
 * skills first, then user skills), so arrow/Enter navigation stays a simple
 * single-counter scheme even though rows are rendered under group headers.
 */
export default function SkillsDropdown({ skills, onSelect, onClose }: SkillsDropdownProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [prevQuery, setPrevQuery] = useState(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset the selection whenever the filter changes. Tracking the previous
  // query in state (and adjusting state during render) keeps this in sync
  // without a setState-in-effect.
  if (prevQuery !== query) {
    setPrevQuery(query);
    setActiveIndex(0);
  }

  // Focus the filter box as soon as the dropdown opens so typing + arrows work
  // without an extra click.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Keep the active row visible while navigating with the keyboard.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, query]);

  // Display order: project first, then user, then plugin — matches the flat
  // index model (project [0,P), user [P,P+U), plugin [P+U, …)).
  const project = filtered.filter((s) => s.source === "project");
  const user = filtered.filter((s) => s.source === "user");
  const plugin = filtered.filter((s) => s.source === "plugin");

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = filtered[activeIndex];
      if (sel) onSelect(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const isEmpty = filtered.length === 0;

  const renderRow = (skill: SkillEntry, idx: number) => (
    <button
      key={`${skill.source}-${skill.name}`}
      type="button"
      data-idx={idx}
      onMouseEnter={() => setActiveIndex(idx)}
      onClick={() => onSelect(skill)}
      className={`w-full text-left px-3 py-1.5 flex flex-col gap-0.5 transition-colors ${
        activeIndex === idx ? "bg-[var(--bg-tertiary)]" : ""
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="text-sm text-[var(--text-primary)] font-medium truncate">
          /{skill.name}
        </span>
        <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border-color)]">
          {skill.source[0].toUpperCase() + skill.source.slice(1)}
        </span>
      </span>
      {skill.description && (
        <span className="text-xs text-[var(--text-secondary)] truncate">{skill.description}</span>
      )}
    </button>
  );

  const renderGroup = (label: string, items: SkillEntry[], offset: number) =>
    items.length === 0 ? null : (
      <div>
        <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--text-secondary)] opacity-70">
          {label}
        </div>
        {items.map((s, i) => renderRow(s, offset + i))}
      </div>
    );

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-xl shadow-lg max-h-80 overflow-hidden flex flex-col z-20">
      <div className="p-2 border-b border-[var(--border-color)]">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Filter skills… (↑↓ to navigate, Enter to insert, Esc to close)"
          className="w-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] placeholder-[var(--text-secondary)] rounded-lg px-3 py-1.5 text-sm outline-none border border-transparent focus:border-[var(--accent)]"
        />
      </div>
      <div ref={listRef} className="overflow-y-auto flex-1 pb-1">
        {isEmpty ? (
          <div className="px-3 py-4 text-center text-xs text-[var(--text-secondary)]">
            {query ? "No skills match your filter" : "No skills found"}
          </div>
        ) : (
          <>
            {renderGroup("Project", project, 0)}
            {renderGroup("User", user, project.length)}
            {renderGroup("Plugin", plugin, project.length + user.length)}
          </>
        )}
      </div>
    </div>
  );
}
