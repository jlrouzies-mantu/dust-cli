import { Box, Text } from "ink";
import React from "react";

import type { Command } from "../commands/types.js";
import { splitCommandQuery } from "../commands/types.js";

interface CommandSelectorProps {
  query: string;
  selectedIndex: number;
  commands: Command[];
  onSelect: (command: Command) => void;
}

export function CommandSelector({
  query,
  selectedIndex,
  commands,
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

  return (
    <Box flexDirection="column">
      <Box paddingX={1} flexDirection="column">
        {filteredCommands.map((command, index) => {
          const isSelected = index === selectedIndex;
          return (
            <Box key={command.name} flexDirection="row">
              {/*
                Wide enough for the longest command name plus its leading
                slash and a column of gap - "/claude-code-mode" is 17
                characters, and a name that overflows this box pushes the
                whole description column out of alignment.
              */}
              <Box width={20}>
                <Text color={isSelected ? "blue" : undefined} bold={isSelected}>
                  /{command.name}
                </Text>
              </Box>
              <Text
                dimColor={!isSelected}
                color={isSelected ? undefined : undefined}
              >
                {command.description}
              </Text>
              {/*
                Argument syntax is only worth the width on the highlighted
                row - showing it on every row would push the descriptions
                off-screen on a narrow terminal.
              */}
              {isSelected && command.usage && (
                <Text dimColor> {command.usage}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
