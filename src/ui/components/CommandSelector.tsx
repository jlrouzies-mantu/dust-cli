import chalk from "chalk";
import { Box, Text } from "ink";
import React from "react";

import { windowAround } from "../../utils/liveRegion.js";
import type { Command } from "../commands/types.js";
import { splitCommandQuery } from "../commands/types.js";

interface CommandSelectorProps {
  query: string;
  selectedIndex: number;
  commands: Command[];
  onSelect: (command: Command) => void;
  // How many commands to show at once; the window follows the selection.
  // Bounded because the full list (18 entries, more once descriptions wrap)
  // is taller than many terminals, and a live region that tall forces Ink
  // to repaint the entire conversation on every keystroke - see
  // utils/liveRegion.ts.
  maxVisible?: number;
}

export function CommandSelector({
  query,
  selectedIndex,
  commands,
  maxVisible = 8,
}: CommandSelectorProps) {
  // Filter on the command name alone, ignoring any arguments already typed -
  // otherwise the menu would go empty at the first space of
  // "/loop 5m check CI". Kept identical to the filter Chat.tsx applies when
  // dispatching, so what's highlighted is what runs.
  const [nameQuery] = splitCommandQuery(query);
  const filteredCommands = commands.filter((command) =>
    command.name.toLowerCase().startsWith(nameQuery.toLowerCase())
  );

  if (filteredCommands.length === 0) {
    return (
      <Box flexDirection="column">
        <Box paddingX={1}>
          <Text dimColor>No commands found</Text>
        </Box>
      </Box>
    );
  }

  const { start, end } = windowAround(
    selectedIndex,
    filteredCommands.length,
    maxVisible
  );
  const hiddenAbove = start;
  const hiddenBelow = filteredCommands.length - end;

  return (
    <Box flexDirection="column">
      <Box paddingX={1} flexDirection="column">
        {hiddenAbove > 0 && <Text dimColor>{`  ↑ ${hiddenAbove} more`}</Text>}
        {filteredCommands.slice(start, end).map((command, offset) => {
          const isSelected = start + offset === selectedIndex;
          return (
            <Box key={command.name} flexDirection="row">
              {/*
                Wide enough for the longest command name plus its leading
                slash and a column of gap - "/claude-code-mode" is 17
                characters, and a name that overflows this box pushes the
                whole description column out of alignment.
              */}
              <Box width={20} flexShrink={0}>
                <Text color={isSelected ? "blue" : undefined} bold={isSelected}>
                  /{command.name}
                </Text>
              </Box>
              {/*
                One pre-coloured, truncated Text rather than wrapping
                siblings: each command stays exactly one row, so the window
                above is an actual height bound and not just an entry count.
                Argument syntax is only worth the width on the highlighted
                row - showing it on every row would push the descriptions
                off-screen on a narrow terminal.
              */}
              <Box flexGrow={1}>
                <Text wrap="truncate-end">
                  {(isSelected ? command.description : chalk.dim(command.description)) +
                    (isSelected && command.usage
                      ? chalk.dim(` ${command.usage}`)
                      : "")}
                </Text>
              </Box>
            </Box>
          );
        })}
        {hiddenBelow > 0 && <Text dimColor>{`  ↓ ${hiddenBelow} more`}</Text>}
      </Box>
    </Box>
  );
}
