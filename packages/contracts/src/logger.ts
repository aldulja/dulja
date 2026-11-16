export type LogFields = Record<string, unknown>;
export interface Logger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
  child(fields: LogFields): Logger;
}
export type LogLevel = "debug" | "info" | "warn" | "error";
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const FORBIDDEN_LOG_FIELD = /token|password|authorization|card|pin|secret/i;
export function createLogger(
  options: { level?: LogLevel; sink?: (line: string) => void; base?: LogFields } = {},
): Logger {
  const level = options.level ?? "info",
    sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`)),
    base = options.base ?? {};
  const emit = (kind: LogLevel, fields: LogFields, msg: string) => {
    if (order[kind] < order[level]) return;
    const merged = { ...base, ...fields };
    const dropped = Object.keys(merged).filter((key) => FORBIDDEN_LOG_FIELD.test(key));
    for (const key of dropped) delete merged[key];
    if (dropped.length)
      sink(
        JSON.stringify({
          time: new Date().toISOString(),
          level: "warn",
          msg: "forbidden_log_field",
          fields: dropped,
        }),
      );
    sink(JSON.stringify({ time: new Date().toISOString(), level: kind, msg, ...merged }));
  };
  return {
    debug: (f, m) => emit("debug", f, m),
    info: (f, m) => emit("info", f, m),
    warn: (f, m) => emit("warn", f, m),
    error: (f, m) => emit("error", f, m),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}
