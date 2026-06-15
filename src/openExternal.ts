import { invoke } from "@tauri-apps/api/core";

/**
 * Open a URL in the user's system default browser. Pixie no longer ships an
 * in-app browser, so every external link (clicked in a message, a tool target,
 * etc.) is delegated to the OS. The Rust side (`open_external`) re-validates
 * the scheme, so this guard is just defense in depth / fast feedback.
 */
export async function openExternal(url: string): Promise<void> {
  const scheme = url.trim().toLowerCase();
  if (
    !scheme.startsWith("http://") &&
    !scheme.startsWith("https://") &&
    !scheme.startsWith("mailto:") &&
    !scheme.startsWith("tel:")
  ) {
    console.warn("openExternal: refusing non-URL target", url);
    return;
  }
  try {
    await invoke("open_external", { target: url });
  } catch (e) {
    console.error("openExternal: failed to open", url, e);
  }
}
