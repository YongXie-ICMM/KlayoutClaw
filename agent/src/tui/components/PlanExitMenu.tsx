/**
 * PlanExitMenu — 4-option approval menu rendered when plan mode exits via
 * the /plan slash command (not via the exit_plan_mode tool, per D3).
 *
 * Mounted conditionally by App.tsx on `planExitMenu !== null`. When the menu
 * closes the component unmounts and its text disappears from the frame —
 * which is the behavior the Group 3 test "after plan exit menu closes, input
 * buffer accepts new characters again" asserts on.
 */

import React from "react";
import { Box, Text } from "ink";

interface PlanExitMenuProps {
  planFilePath: string;
}

export function PlanExitMenu({ planFilePath }: PlanExitMenuProps) {
  return (
    <Box flexDirection="column" marginY={0} paddingLeft={2}>
      <Text wrap="end">{`Plan complete. Full tool access restored.\nPlan file: ${planFilePath}`}</Text>
      <Text> </Text>
      <Text>{`  1  Clear context & execute`}</Text>
      <Text>{`  2  Execute`}</Text>
      <Text>{`  3  Revise (re-enter plan mode)`}</Text>
      <Text>{`  4  Do nothing`}</Text>
      <Text> </Text>
      <Text>Press 1-4 to choose:</Text>
    </Box>
  );
}
