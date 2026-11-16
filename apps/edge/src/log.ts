export function edgeLog(fields: Record<string, string | number>, message: string): void {
  // oxlint-disable-next-line no-console -- Workers have no process.stdout; this is the edge logging seam.
  console.log(
    JSON.stringify({ level: "info", msg: message, ...fields, time: new Date().toISOString() }),
  );
}
