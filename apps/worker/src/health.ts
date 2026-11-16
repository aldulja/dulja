export interface WorkerHealth {
  readonly status: "ok";
  readonly jobs: readonly string[];
  readonly startedAt: string;
}

export function startWorkerHealth(
  jobs: () => readonly string[],
  port = Number(process.env["PORT"] ?? "8080"),
): { port: number; stop(): void } {
  const startedAt = new Date().toISOString();
  const server = Bun.serve({
    port,
    fetch(request) {
      if (new URL(request.url).pathname !== "/healthz")
        return new Response("not found", { status: 404 });
      const body: WorkerHealth = { status: "ok", jobs: jobs(), startedAt };
      return Response.json(body);
    },
  });
  const boundPort = server.port;
  if (boundPort === undefined) {
    server.stop(true);
    throw new Error("worker health listener did not bind a TCP port");
  }
  return { port: boundPort, stop: () => void server.stop(true) };
}
