import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * The Durable Object suite, in a real `workerd`.
 *
 * `RateLimiter` and `DailyBudget` are ledgers whose behaviour lives in their
 * storage, not in a function that can be lifted out and called: "does a refund
 * land on the day it was charged" is a question about two `put`s and the clock
 * between them. That was argued in review rather than demonstrated, and the
 * argument shipped a P1.
 *
 * Separate from `npm test` on purpose. This one boots a runtime and reads
 * `wrangler.jsonc`, so it is neither instant nor hermetic the way the pure
 * suite is, and folding them together would cost the property that makes the
 * pure one worth running constantly.
 *
 * The pool is a plugin, not `defineWorkersConfig` — that helper and the
 * `/config` entry point are gone as of `@cloudflare/vitest-pool-workers@0.22`,
 * which is the version that supports Vitest 4.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      // Bindings and migrations come from the real deployment config, so a test
      // cannot pass against a shape that is not what ships.
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/workers/**/*.test.ts"],
  },
});
