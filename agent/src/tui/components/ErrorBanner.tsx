/**
 * Red error display banner.
 */

import React from "react";
import { Text, Box } from "ink";
import { theme } from "../theme.js";

interface ErrorBannerProps {
  error: string;
}

export function ErrorBanner({ error }: ErrorBannerProps) {
  return (
    <Box marginY={1} paddingLeft={2}>
      <Text>{theme.error("Error: ")}{theme.errorText(error)}</Text>
    </Box>
  );
}
