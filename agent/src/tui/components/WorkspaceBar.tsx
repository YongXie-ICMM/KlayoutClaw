/**
 * WorkspaceBar — collapsed/expanded workspace panel showing file list and integrity status.
 */

import React from "react";
import { Box, Text } from "ink";
import { Chalk } from "chalk";

const chalk = new Chalk({ level: 3 });

export interface WorkspaceFile {
  name: string;
  path: string;
  description: string;
}

export interface WorkspaceIntegrity {
  ok: boolean;
  fileCount: number;
  issues: string[];
}

interface WorkspaceBarProps {
  expanded: boolean;
  files: WorkspaceFile[];
  integrity: WorkspaceIntegrity;
}

export function WorkspaceBar({ expanded, files, integrity }: WorkspaceBarProps) {
  const dotColorFn = integrity.ok
    ? chalk.green
    : integrity.issues.length > 0
      ? chalk.red
      : chalk.yellow;

  const dot = dotColorFn("\u25CF");

  if (!expanded) {
    // Collapsed view: integrity dot + brief hint
    return (
      <Box>
        <Text>{dot} Workspace ({integrity.fileCount} files)</Text>
      </Box>
    );
  }

  // Expanded view: bordered file list with names and descriptions
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text>{dot} {chalk.bold(`Workspace (${integrity.fileCount} files)`)}</Text>
      {files.map((file) => (
        <Box key={file.name} marginLeft={2}>
          <Text>{chalk.bold(file.name.padEnd(16))}{chalk.dim(file.description)}</Text>
        </Box>
      ))}
      {integrity.issues.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {integrity.issues.map((issue, i) => (
            <Text key={i}>{chalk.red(issue)}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
