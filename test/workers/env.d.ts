/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as WorkerEnv } from "../../src/types";

/**
 * `env` in these tests is typed `Cloudflare.Env`, which `wrangler types` would
 * generate and this project does not commit. Point it at the Worker's own `Env`
 * rather than restating the bindings: a binding renamed in `wrangler.jsonc` and
 * in `src/types.ts` but not here would otherwise still compile, and turn up as
 * `undefined` halfway through a test.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
