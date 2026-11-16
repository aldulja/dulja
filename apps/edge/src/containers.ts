import { Container } from "@cloudflare/containers";
import { containerSecrets } from "./container-env";
import type { Env } from "./env";

export class ApiContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";

  constructor(state: DurableObjectState<{}>, env: Env) {
    super(state, env);
    this.envVars = containerSecrets(env, "api");
  }
}
export class WorkerContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "24h";

  constructor(state: DurableObjectState<{}>, env: Env) {
    super(state, env);
    this.envVars = containerSecrets(env, "worker");
  }
}
