import type { Logger } from "@dulja/contracts";

const emit = (level: string) => (fields: Record<string, unknown>, msg: string) =>
  process.stdout.write(
    `${JSON.stringify({ level, msg, ...fields, time: new Date().toISOString() })}\n`,
  );

const consoleLogger = (): Logger => {
  const make = (base: Record<string, unknown>): Logger => ({
    debug: (fields, message) => emit("debug")({ ...base, ...fields }, message),
    info: (fields, message) => emit("info")({ ...base, ...fields }, message),
    warn: (fields, message) => emit("warn")({ ...base, ...fields }, message),
    error: (fields, message) => emit("error")({ ...base, ...fields }, message),
    child: (fields) => make({ ...base, ...fields }),
  });
  return make({});
};
let current: Logger = consoleLogger();
export function log(): Logger {
  return current;
}
export function setLogger(logger: Logger): void {
  current = logger;
}
