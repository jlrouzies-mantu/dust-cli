import { Box, Text } from "ink";
import React from "react";

import { PICKER_PURPLE } from "../../utils/brand.js";

// Round checkbox glyphs. U+25CF/U+25CB specifically: this fork has a
// documented history of fancier Unicode rendering as garbage or misaligned
// boxes on legacy Windows consoles (see README's Fixed table), and these
// two are about as universally supported as non-ASCII gets - unlike, say,
// U+276F or the boxed-check glyphs.
const CHECKED_GLYPH = "●";
const UNCHECKED_GLYPH = "○";

// Ceiling on the name column so one pathological skill name can't push
// every description off the right edge of the terminal.
const MAX_NAME_COLUMN = 28;

export interface InlineSelectorItem {
  id: string;
  label: string;
  description?: string;
  // Multi-select modes only (see `multiSelect`): renders a checkbox and
  // dims the label while unchecked, so "off" reads as off at a glance
  // rather than only from the box.
  checked?: boolean;
}

interface InlineSelectorProps {
  items: InlineSelectorItem[];
  query: string;
  selectedIndex: number;
  maxVisible?: number;
  prompt?: string;
  header?: React.ReactNode;
  // Turns the list into a checklist: each row gets a [x]/[ ] box driven by
  // the item's own `checked`. The caller owns the toggling (Space) and
  // what confirming means - this only draws it.
  multiSelect?: boolean;
  // Rendered under the list, after the "(N more)" count. For key hints and
  // advisories that belong to the picker rather than to any one row.
  footer?: React.ReactNode;
}

export function InlineSelector({
  items,
  query,
  selectedIndex,
  maxVisible = 10,
  prompt,
  header,
  multiSelect = false,
  footer,
}: InlineSelectorProps) {
  const filtered = items.filter((item) =>
    item.label.toLowerCase().includes(query.toLowerCase())
  );

  // A window that follows the selection, rather than always showing the
  // first `maxVisible` items: with a long list (the ~27-entry /model
  // catalogue) a fixed window means everything past the tenth row is
  // unreachable by arrow key. The window only moves once the selection
  // would leave it, so short lists never scroll and the rows stay put
  // while you arrow through what's already on screen.
  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      filtered.length - maxVisible
    )
  );
  const visible = filtered.slice(windowStart, windowStart + maxVisible);
  const hiddenAbove = windowStart;
  const hiddenBelow = filtered.length - (windowStart + visible.length);
  // Index within the window, since the caller's selectedIndex addresses the
  // whole filtered list.
  const selectedInWindow = selectedIndex - windowStart;

  // Descriptions line up in one column, sized to the longest *visible*
  // name so the gap doesn't jump around as the list is filtered, and
  // capped so one long name can't shove every description off-screen.
  // The gutter is a separate cell rather than padding baked in here, so a
  // name that hits the cap and truncates still can't run into its own
  // description. Only meaningful in multi-select; single-select keeps its
  // original inline layout.
  const nameColumnWidth = multiSelect
    ? Math.min(
        Math.max(...visible.map((item) => item.label.length), 0),
        MAX_NAME_COLUMN
      )
    : 0;

  return (
    // marginBottom separates the last option from whatever renders next -
    // the status bar sits directly below this in Conversation.tsx with no
    // gap of its own, so without this the final choice ("Reject", "Approve",
    // ...) ran straight into the status bar line with no visual break.
    <Box flexDirection="column" marginBottom={1}>
      {header && <Box paddingX={1}>{header}</Box>}
      {prompt && (
        // A checklist is something the user reads and acts on rather than
        // a menu they arrow through and dismiss, so it gets a little more
        // room to breathe under its heading.
        <Box paddingX={1} marginBottom={multiSelect ? 1 : 0}>
          <Text dimColor>{prompt}</Text>
        </Box>
      )}
      {visible.length === 0 ? (
        <Box paddingX={1}>
          <Text dimColor>No matches</Text>
        </Box>
      ) : (
        <Box paddingX={1} flexDirection="column">
          {visible.map((item, index) => {
            const isSelected = index === selectedInWindow;

            // Single-select modes keep the original inline layout - they're
            // shared with the approval/diff/plan/file pickers, whose labels
            // and descriptions vary wildly in length and don't benefit from
            // a fixed column. The only change is that the description
            // truncates instead of overflowing: siblings in a row-direction
            // Box don't wrap (see the InputBox comment on the same Ink
            // behaviour), so a long one used to spill past the terminal
            // edge and push the row's real width out of step with what Ink
            // thinks it drew.
            if (!multiSelect) {
              return (
                <Box key={item.id} flexDirection="row">
                  <Box flexShrink={0}>
                    <Text
                      color={isSelected ? "blue" : undefined}
                      bold={isSelected}
                    >
                      {isSelected ? "> " : "  "}
                      {item.label}
                    </Text>
                  </Box>
                  {item.description && (
                    <Box flexGrow={1}>
                      <Text dimColor wrap="truncate-end">
                        {"  "}
                        {item.description}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            }

            return (
              // flexShrink={0} on every fixed-width cell: without it
              // flexbox shrinks them to make room for the description,
              // which destroys the alignment this layout exists for.
              <Box key={item.id} flexDirection="row">
                <Box flexShrink={0}>
                  {/*
                    Purple rather than the single-select modes' blue, so
                    the cursor sits in the same colour family as the
                    checked dot on the same row.
                  */}
                  <Text color={isSelected ? PICKER_PURPLE : undefined} bold>
                    {isSelected ? "> " : "  "}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  {/*
                    The trailing space is part of the string rather than
                    box padding: U+25CF/U+25CB are East-Asian-"ambiguous"
                    width, so a fixed-width box around them pads
                    inconsistently depending on how the terminal measures
                    them. A literal space always works.
                  */}
                  <Text
                    color={item.checked ? PICKER_PURPLE : undefined}
                    dimColor={!item.checked}
                  >
                    {item.checked ? `${CHECKED_GLYPH} ` : `${UNCHECKED_GLYPH} `}
                  </Text>
                </Box>
                <Box width={nameColumnWidth} flexShrink={0}>
                  <Text
                    color={isSelected ? PICKER_PURPLE : undefined}
                    bold={isSelected}
                    dimColor={!item.checked && !isSelected}
                    wrap="truncate-end"
                  >
                    {item.label}
                  </Text>
                </Box>
                {item.description && (
                  <>
                    <Box width={2} flexShrink={0} />
                    {/*
                      flexGrow rather than a fixed width so the description
                      uses whatever the terminal has left, and truncates
                      instead of wrapping - a wrapped row would break the
                      column alignment the rest of this layout exists for.
                    */}
                    <Box flexGrow={1}>
                      <Text dimColor wrap="truncate-end">
                        {item.description}
                      </Text>
                    </Box>
                  </>
                )}
              </Box>
            );
          })}
          {(hiddenAbove > 0 || hiddenBelow > 0) && (
            // Counts on both sides so the list reads as a window into
            // something longer, and it's obvious more can be reached by
            // holding the arrow key - a single trailing "(N more)" looked
            // like a hard cap.
            <Box>
              <Text dimColor>
                {hiddenAbove > 0 ? `  ↑ ${hiddenAbove} above` : ""}
                {hiddenAbove > 0 && hiddenBelow > 0 ? " · " : ""}
                {hiddenBelow > 0 ? `  ↓ ${hiddenBelow} below` : ""}
              </Text>
            </Box>
          )}
        </Box>
      )}
      {/*
        Outside the empty/non-empty branch above on purpose: an empty list
        is exactly when a footer explaining *why* it might be empty (e.g.
        "enable /claude-code-mode to see those too") matters most.
      */}
      {footer && (
        <Box paddingX={1} marginTop={1} flexDirection="column">
          {footer}
        </Box>
      )}
    </Box>
  );
}
