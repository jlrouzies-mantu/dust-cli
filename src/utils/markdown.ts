import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;

function ensureConfigured(): void {
  if (configured) {
    return;
  }
  marked.use(markedTerminal());
  configured = true;
}

/**
 * Renders markdown (code fences, bold/italic, headers, lists, ...) to an
 * ANSI-styled string suitable for direct terminal output, instead of
 * showing the raw markdown syntax literally.
 */
export function renderMarkdown(text: string): string {
  if (!text) {
    return text;
  }
  ensureConfigured();
  try {
    return String(marked.parse(text)).replace(/\n+$/, "");
  } catch {
    // Never let a rendering failure hide the agent's actual answer.
    return text;
  }
}
