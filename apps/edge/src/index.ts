import { getContainer } from "@cloudflare/containers";
import { ApiContainer, WorkerContainer } from "./containers";
import type { Env } from "./env";
import { handleFetch, handleScheduled, type RouterDeps } from "./router";

export { ApiContainer, WorkerContainer };
function containerDeps(env: Env): RouterDeps {
  return {
    forward: (request) => getContainer(env.API, "api").fetch(request),
    ping: () =>
      getContainer(env.WORKER, "worker").fetch(new Request("https://worker.internal/healthz")),
  };
}
export default {
  fetch: (request: Request, env: Env) => handleFetch(request, env, containerDeps(env)),
  scheduled: (_controller: ScheduledController, env: Env) =>
    handleScheduled(env, containerDeps(env)),
} satisfies ExportedHandler<Env>;
