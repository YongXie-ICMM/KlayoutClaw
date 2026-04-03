import { defineConfig } from "vitest/config";
import { unitFiles } from "./vitest.files.js";

export default defineConfig({
  test: {
    include: unitFiles,
    globals: true,
    testTimeout: 30000,
  },
});
