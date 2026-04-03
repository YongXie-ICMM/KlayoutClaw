import { defineConfig } from "vitest/config";
import { integrationFiles } from "./vitest.files.js";

export default defineConfig({
  test: {
    include: integrationFiles,
    globals: true,
    testTimeout: 30000,
  },
});
