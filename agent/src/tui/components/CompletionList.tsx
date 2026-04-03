/**
 * Dropdown list of matching slash commands with highlighted selection.
 */

import React from "react";
import { Box, Text } from "ink";
import { Chalk } from "chalk";
import type { CommandMatch } from "../commands.js";

// Force color output regardless of terminal detection
const chalk = new Chalk({ level: 3 });

interface CompletionListProps {
  matches: CommandMatch[];
  selectedIndex: number;
}

export function CompletionList({ matches, selectedIndex }: CompletionListProps) {
  return (
    <Box
      borderStyle="single"
      borderColor="green"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {matches.map((match, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={match.name}>
            <Text>
              {isSelected ? chalk.green.bold("> ") : "  "}
              {isSelected
                ? chalk.green.bold(match.name.padEnd(10))
                : chalk.green(match.name.padEnd(10))}
              <Text dimColor>{match.description}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
