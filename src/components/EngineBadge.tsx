import type { AgentEngineId } from "../types";
import { AGENT_ENGINES } from "../types";

const CURSOR_ICON = new URL("../assets/engine-icons/cursor.svg", import.meta.url).href;
const CLAUDE_ICON = new URL("../assets/engine-icons/claude.svg", import.meta.url).href;
const CODEBUDDY_ICON = new URL("../assets/engine-icons/codebuddy.svg", import.meta.url).href;

function engineAbbr(id: AgentEngineId): string {
  if (id === "claude") return "Cl";
  if (id === "cursor") return "Cu";
  return "Cb";
}

function engineColorClasses(id: AgentEngineId): string {
  if (id === "claude") return "bg-violet-500/15 text-violet-200 ring-violet-400/30";
  if (id === "cursor") return "bg-emerald-500/15 text-emerald-200 ring-emerald-400/30";
  return "bg-amber-500/15 text-amber-200 ring-amber-400/30";
}

function engineIconHref(id: AgentEngineId): string | null {
  if (id === "cursor") return CURSOR_ICON;
  if (id === "claude") return CLAUDE_ICON;
  if (id === "codebuddy") return CODEBUDDY_ICON;
  return null;
}

export default function EngineBadge({
  engine,
  showLabel = false,
  className = "",
}: {
  engine: AgentEngineId;
  showLabel?: boolean;
  className?: string;
}) {
  const label = AGENT_ENGINES.find((e) => e.id === engine)?.label ?? engine;
  const abbr = engineAbbr(engine);
  const colors = engineColorClasses(engine);
  const iconHref = engineIconHref(engine);
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-0.5 py-0.5 rounded text-[8px] leading-none ring-1 ${colors} ${className}`}
      title={label}
      aria-label={label}
    >
      {iconHref ? (
        <img src={iconHref} alt="" className="w-2.5 h-2.5" draggable={false} />
      ) : (
        <span className="font-mono font-semibold tracking-tight">{abbr}</span>
      )}
      {showLabel && <span className="truncate max-w-[120px]">{label}</span>}
    </span>
  );
}

