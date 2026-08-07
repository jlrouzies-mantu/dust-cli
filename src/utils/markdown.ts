import chalk from "chalk";
import type { Token, Tokens } from "marked";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let configured = false;

function ensureConfigured(): void {
  if (configured) {
    return;
  }
  marked.use(
    markedTerminal(
      {},
      // cli-highlight's default theme uses chalk.blue for keyword/literal/
      // class/name tokens (e.g. Python's "def") - a dark ANSI blue that's
      // low-contrast against a dark code-block background. blueBright is
      // still recognizably blue but actually readable.
      {
        theme: {
          keyword: chalk.blueBright,
          literal: chalk.blueBright,
          class: chalk.blueBright,
          name: chalk.blueBright,
        },
      }
    )
  );
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
      // Same marked-terminal@7.3.0/marked@15 incompatibility as the heading
      // fix above, but for inline formatting inside "tight" contexts (list
      // items, and any other spot marked's lexer emits a bare "text" token
      // instead of a "paragraph"): marked-terminal's text() renderer reads
      // token.text directly instead of parsing token.tokens, so bold/italic/
      // etc. inside a list item leaked as literal "**...**" instead of being
      // rendered. Confirmed directly against marked-terminal's own renderer
      // with "- **bold** item".
      text(token: Tokens.Text | Tokens.Escape) {
        if ("tokens" in token && token.tokens?.length) {
          return this.parser.parseInline(token.tokens);
        }
        return token.text;
      },
    },
  });
  configured = true;
}

export interface MarkdownSegment {
  type: "text" | "code";
  content: string;
}

// Dust's web app renders custom directives like
// :preview_file{path="..." title="..." contentType="..."} as interactive
// widgets (e.g. an inline file preview). marked has no idea what this
// syntax means and passes it through as literal text, which just leaks
// the raw `:name{...}` syntax in the CLI. Replace known/unknown
// directives with a readable placeholder instead.
function humanizeDustDirectives(text: string): string {
  return (
    text
      .replace(/:(\w+)\{([^}]*)\}/g, (_match, name: string, attrs: string) => {
        const attrMap: Record<string, string> = {};
        for (const m of attrs.matchAll(/(\w+)="([^"]*)"/g)) {
          attrMap[m[1]] = m[2];
        }

        if (name === "preview_file") {
          const label = attrMap.title || attrMap.path || "file";
          return `[Generated file: ${label} — not viewable in the CLI, only on the Dust web app]`;
        }

        // Generic fallback for any other Dust-specific directive: show
        // something readable instead of leaking raw `:name{...}` syntax.
        const label = attrMap.title || attrMap.name || attrMap.path || name;
        return `[${label}]`;
      })
      // Citation references (`:cite[abc,def]`) use the bracket form of the
      // same directive syntax. The web app turns these into numbered,
      // clickable footnotes, but the reference ids alone carry no
      // information without that link data - so drop them entirely rather
      // than leaving `:cite[duj,aqj]` noise mid-sentence. The leading
      // space is folded in so removal doesn't leave a double space before
      // the sentence's period.
      .replace(/ ?:cite\[[^\]]*\]/g, "")
      // Any other bracket-form directive: keep something readable rather
      // than leaking the raw syntax.
      .replace(/:(\w+)\[([^\]]*)\]/g, (_match, _name: string, inner: string) =>
        inner ? `[${inner}]` : ""
      )
  );
}

// LaTeX command -> Unicode replacements for the common subset agents
// actually emit (Greek letters, operators, arrows, set theory). Anything
// not in this map falls back to just dropping the backslash, which reads
// far better than leaving raw "\Command" sequences in the terminal.
const LATEX_SYMBOL_MAP: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  cdot: "·",
  cdots: "⋯",
  ldots: "…",
  dots: "…",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  approx: "≈",
  neq: "≠",
  leq: "≤",
  geq: "≥",
  ll: "≪",
  gg: "≫",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  forall: "∀",
  exists: "∃",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  supset: "⊃",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  sum: "Σ",
  prod: "Π",
  int: "∫",
  hbar: "ℏ",
  Box: "□",
  longleftrightarrow: "⟷",
  longrightarrow: "⟶",
  // Sizing/grouping commands that carry no meaning once rendered as plain
  // text - drop them rather than leaking the word "left"/"right"/etc.
  left: "",
  right: "",
  quad: "  ",
  qquad: "    ",
};

// Commands whose argument should just be kept as-is, dropping the command
// itself - styling (calligraphic, roman, bold, plain text) a terminal can't
// convey anyway.
const LATEX_PASSTHROUGH_COMMANDS = new Set([
  "mathcal",
  "mathrm",
  "mathbf",
  "mathbb",
  "mathfrak",
  "mathnormal",
  "boldsymbol",
  "operatorname",
  "text",
  "textbf",
  "textit",
  "textrm",
  "textnormal",
  "mbox",
]);

// Accent commands -> a Unicode combining character appended after the
// (recursively converted) argument, e.g. \hat{x} -> "x" + combining
// circumflex.
const LATEX_ACCENT_COMMANDS: Record<string, string> = {
  hat: "̂",
  widehat: "̂",
  dot: "̇",
  ddot: "̈",
  vec: "⃗",
  bar: "̄",
  overline: "̄",
  tilde: "̃",
  widetilde: "̃",
};

// Reads a single LaTeX "argument" starting at index `start`: a
// balanced-brace group `{...}` (which may itself contain nested braces -
// this is what a plain regex like `\{([^{}]*)\}` can't handle, and why
// `\frac{1}{\sqrt{-g}}` used to come out mangled), a single `\command`
// token, or - as a last resort - one bare character (covering `\hat x`
// style unbraced accents).
function readLatexArg(
  src: string,
  start: number
): { content: string; next: number } {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) {
    i++;
  }
  if (src[i] === "{") {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") {
        depth++;
      } else if (src[j] === "}") {
        depth--;
        if (depth === 0) {
          return { content: src.slice(i + 1, j), next: j + 1 };
        }
      }
    }
    // Unbalanced - treat the rest of the string as the argument rather
    // than looping forever.
    return { content: src.slice(i + 1), next: src.length };
  }
  if (src[i] === "\\") {
    const m = /^\\[A-Za-z]+/.exec(src.slice(i));
    if (m) {
      return { content: m[0], next: i + m[0].length };
    }
  }
  return { content: src[i] ?? "", next: i + 1 };
}

// Converts LaTeX math source to plain, terminal-readable text. Not a full
// LaTeX parser - just enough of the common subset (Greek letters, \frac,
// \sqrt, accents, styling commands, sub/superscripts, basic operators) to
// make equations legible instead of showing raw backslash commands, which
// is all a terminal can reasonably do anyway (no real math typesetting -
// no fraction bars, sized radicals, etc.). Written as a small recursive
// scanner rather than regex specifically so nested commands (a \sqrt
// inside a \frac's argument, a \mathcal inside a \hat, ...) resolve
// correctly regardless of nesting order.
function latexToPlainText(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === "\\") {
      const cmdMatch = /^\\([A-Za-z]+)/.exec(src.slice(i));
      if (cmdMatch) {
        const word = cmdMatch[1];
        const afterCmd = i + cmdMatch[0].length;

        if (word === "frac") {
          const num = readLatexArg(src, afterCmd);
          const den = readLatexArg(src, num.next);
          out += `(${latexToPlainText(num.content)})/(${latexToPlainText(den.content)})`;
          i = den.next;
          continue;
        }
        if (word === "sqrt") {
          const arg = readLatexArg(src, afterCmd);
          out += `√(${latexToPlainText(arg.content)})`;
          i = arg.next;
          continue;
        }
        if (word === "boxed") {
          const arg = readLatexArg(src, afterCmd);
          out += `[${latexToPlainText(arg.content)}]`;
          i = arg.next;
          continue;
        }
        if (LATEX_PASSTHROUGH_COMMANDS.has(word)) {
          const arg = readLatexArg(src, afterCmd);
          out += latexToPlainText(arg.content);
          i = arg.next;
          continue;
        }
        if (word in LATEX_ACCENT_COMMANDS) {
          const arg = readLatexArg(src, afterCmd);
          out += latexToPlainText(arg.content) + LATEX_ACCENT_COMMANDS[word];
          i = arg.next;
          continue;
        }
        if (word in LATEX_SYMBOL_MAP) {
          out += LATEX_SYMBOL_MAP[word];
          i = afterCmd;
          continue;
        }
        // Unknown command (e.g. \displaystyle) - drop the backslash and
        // keep the word rather than leaking the raw escape.
        out += word;
        i = afterCmd;
        continue;
      }
      if (src[i + 1] === "\\") {
        out += "\n";
        i += 2;
        continue;
      }
      if (i + 1 < n && ",;! ".includes(src[i + 1])) {
        out += " ";
        i += 2;
        continue;
      }
      // Backslash-escaped punctuation (\$, \%, \&, ...) - keep the literal
      // character, drop the backslash.
      if (i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if ((ch === "_" || ch === "^") && i + 1 < n) {
      const arg = readLatexArg(src, i + 1);
      const rendered = latexToPlainText(arg.content);
      // Keep the compact form for a single plain character (e.g. c^4,
      // x_i) rather than always parenthesizing.
      out += rendered.length === 1 ? ch + rendered : `${ch}(${rendered})`;
      i = arg.next;
      continue;
    }

    if (ch === "{") {
      const arg = readLatexArg(src, i);
      out += latexToPlainText(arg.content);
      i = arg.next;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

// A line consisting of just "=" or "-" (Markdown's Setext heading
// underline) or starting with "-"/"*"/"+"/"#"/">" (bullet list / heading /
// blockquote markers) is otherwise indistinguishable from real Markdown
// syntax once LaTeX has been converted to plain text - e.g. an equation
// broken across lines as "lhs\n=\nrhs" silently swallows the "=" and turns
// "lhs" into a heading. Backslash-escaping the leading character is a
// no-op for the *visible* text (Commonmark drops the backslash at inline
// scope) but changes what the raw line looks like at block-parsing time,
// so it's not read as heading/list/blockquote syntax.
function escapeMarkdownLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)([-=*+#>])/, "$1\\$2"))
    .join("\n");
}

// Agents occasionally answer with LaTeX math ($...$ / $$...$$), which a
// terminal can't typeset - marked would otherwise pass it through as
// literal text, and worse, LaTeX's own syntax (underscores for subscripts,
// braces) collides with markdown's emphasis/escaping rules and can corrupt
// unrelated text later in the same paragraph. Replace each math span with
// its humanized plain-text form before markdown ever sees it.
function humanizeLatexMath(text: string): string {
  return text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner: string) => {
      const plain = escapeMarkdownLineStarts(
        latexToPlainText(inner.trim())
      );
      return plain.includes("\n") ? `\n${plain}\n` : plain;
    })
    .replace(/\$([^$\n]+?)\$/g, (m, inner: string) => {
      // Single "$" is ambiguous with plain currency ("$5 and $10" would
      // otherwise read as one inline-math span spanning both amounts, and
      // eat both dollar signs). Only treat it as math when the content
      // actually looks like LaTeX - a command, or a sub/superscript - and
      // doesn't start/end with whitespace like "$ 5 " would.
      if (!/\\[a-zA-Z]|[_^]/.test(inner) || /^\s|\s$/.test(inner)) {
        return m;
      }
      return escapeMarkdownLineStarts(latexToPlainText(inner));
    });
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
    const tokens = marked.lexer(humanizeDustDirectives(humanizeLatexMath(text)));
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
