import { defineConfig } from "vitest/config";

/**
 * The pure suite: parsing, validation, quota arithmetic, aggregation.
 *
 * `test/workers/` is excluded because it needs a real Workers runtime and its
 * own pool — see `vitest.workers.config.ts`. Keeping it out is the point of
 * having two: `npm test` stays offline, credit-free and safe to run in a loop,
 * which is what makes it usable as the inner loop while changing a parser.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "test/workers/**", "test/e2e/**"],
  },
});
