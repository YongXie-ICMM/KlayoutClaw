import { defineConfig } from "vitest/config";
import { e2eFiles } from "./vitest.files.js";

export default defineConfig({
  test: {
    include: e2eFiles,
    globals: true,
    testTimeout: 60000,
  },
});
