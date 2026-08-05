import chalk from "chalk";
import type { Token, Tokens } from "marked";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;

function ensureConfigured(): void {
  if (configured) {
    return;
  }
  marked.use(markedTerminal());
  // marked-terminal@7.3.0's heading renderer doesn't apply (confirmed even
  // with their own README example: "# Hello" is left completely untouched,
  // the "#" never gets stripped) — stacking this override on top fixes it
  // without needing to patch node_modules or pin an older marked-terminal.
  marked.use({
    renderer: {
      heading(token: Tokens.Heading) {
        const text = this.parser.parseInline(token.tokens);
        return `${chalk.bold.underline(text)}\n\n`;
      },
    },
  });
  configured = true;
}

export interface MarkdownSegment {
  type: "text" | "code";
  content: string;
}

// Strips SGR color/style escape sequences (the only kind cli-highlight /
// marked-terminal emit) so line width can be measured on visible
// characters only, not the ANSI bytes.
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// Ink's Text backgroundColor only paints behind actual characters, so a
// code block's background looks patchy (only as wide as each line's own
// text) unless every line is padded out to the block's widest line with
// plain spaces first.
function padCodeBlockToBlockWidth(rendered: string): string {
  const lines = rendered.split("\n");
  const widths = lines.map((line) => stripAnsi(line).length);
  const maxWidth = Math.max(...widths, 0);
  return lines
    .map((line, i) => line + " ".repeat(Math.max(0, maxWidth - widths[i])))
    .join("\n");
}

/**
 * Splits markdown into an ordered list of segments, each rendered to an
 * ANSI-styled string (code fences, bold/italic, headers, lists, ...)
 * instead of showing the raw markdown syntax literally. Code blocks are
 * kept as their own segments (type "code") so callers can wrap only those
 * in a bordered box, rather than the whole answer.
 */
export function renderMarkdownSegments(text: string): MarkdownSegment[] {
  if (!text) {
    return [];
  }
  ensureConfigured();
  try {
    const tokens = marked.lexer(text);
    const segments: MarkdownSegment[] = [];
    let textGroup: Token[] = [];

    const flushTextGroup = () => {
      if (textGroup.length === 0) {
        return;
      }
      const rendered = String(marked.parser(textGroup)).replace(/\n+$/, "");
      if (rendered) {
        segments.push({ type: "text", content: rendered });
      }
      textGroup = [];
    };

    for (const token of tokens) {
      if (token.type === "code") {
        flushTextGroup();
        const rendered = String(marked.parser([token])).replace(/\n+$/, "");
        segments.push({
          type: "code",
          content: padCodeBlockToBlockWidth(rendered),
        });
      } else {
        textGroup.push(token);
      }
    }
    flushTextGroup();

    return segments;
  } catch {
    // Never let a rendering failure hide the agent's actual answer.
    return [{ type: "text", content: text }];
  }
}
