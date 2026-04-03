import { defineConfig } from "vitest/config";
import { unitFiles, integrationFiles, e2eFiles } from "./vitest.files.js";

export default defineConfig({
  test: {
    include: [...unitFiles, ...integrationFiles, ...e2eFiles],
    globals: true,
    testTimeout: 30000,
  },
});
