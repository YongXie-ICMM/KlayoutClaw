import { defineConfig } from "vitest/config";
import { e2eFiles } from "./vitest.files.js";

export default defineConfig({
  test: {
    include: e2eFiles,
    globals: true,
    testTimeout: 60000,
    // v0.4.4 Phase 2b: serialize E2E files through one fork. The real
    // Anthropic API + real KLayout combination is flaky when multiple RPC
    // subprocesses race for the same KLayout MCP socket; single-fork keeps
    // sessions strictly sequential at the file level so prior session
    // teardown completes before the next one spins up.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
