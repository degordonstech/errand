import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    // Cold imports on a busy laptop can take several seconds.
    testTimeout: 20_000,
  },
});
