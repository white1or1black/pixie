/**
 * File-extension → Prism/refractor language id map, shared by the file-preview
 * CodeBlock and the diff viewer so coloring stays consistent. refractor's
 * common language set is queried at highlight time via `registered()`;
 * unsupported ids fall back to plain (uncolored) text rather than throwing.
 */
export function languageFromExt(ext: string): string {
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
    ts: "typescript", tsx: "tsx",
    rs: "rust", py: "python", rb: "ruby", go: "go", java: "java",
    kt: "kotlin", kts: "kotlin", scala: "scala", swift: "swift", dart: "dart",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
    cs: "csharp", php: "php", sql: "sql",
    css: "css", scss: "scss", sass: "sass", less: "less",
    html: "html", htm: "html", xml: "xml", svg: "xml", vue: "vue",
    svelte: "svelte",
    json: "json", json5: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    graphql: "graphql", gql: "graphql",
    sh: "bash", bash: "bash", zsh: "bash", fish: "fish", ps1: "powershell",
    md: "markdown", markdown: "markdown",
    dockerfile: "docker", makefile: "makefile",
  };
  return map[ext.toLowerCase()] ?? ext.toLowerCase();
}

/** Lowercased extension without the dot, or "" for dotfiles / no extension. */
export function extOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no extension, or a leading-dot file like ".gitignore"
  return base.slice(dot + 1).toLowerCase();
}

/** languageFromExt applied to a full path. */
export function languageOfPath(path: string): string {
  return languageFromExt(extOf(path));
}
