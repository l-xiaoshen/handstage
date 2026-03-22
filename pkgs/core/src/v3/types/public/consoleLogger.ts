import { LogLevel, type LogLine, type Logger } from "./logs";

function buildConsolePayload(line: LogLine): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    message: line.message,
  };
  if (line.category !== undefined) payload.category = line.category;
  if (line.timestamp !== undefined) payload.timestamp = line.timestamp;
  if (line.id !== undefined) payload.id = line.id;
  if (line.attributes !== undefined) payload.attributes = line.attributes;
  if (line.traceId !== undefined) payload.traceId = line.traceId;
  if (line.spanId !== undefined) payload.spanId = line.spanId;
  if (line.traceFlags !== undefined) payload.traceFlags = line.traceFlags;
  return payload;
}

/**
 * Returns a {@link Logger} that writes to `console.error` / `console.info` / `console.debug`
 * matching {@link LogLevel}. Uses a structured object as the single argument.
 */
export function createConsoleLogger(): Logger {
  return (line: LogLine) => {
    const level = line.level ?? LogLevel.Info;
    const payload = buildConsolePayload(line);

    switch (level) {
      case LogLevel.Error:
        console.error(payload);
        break;
      case LogLevel.Info:
        console.info(payload);
        break;
      case LogLevel.Debug:
        if (typeof console.debug === "function") {
          console.debug(payload);
        } else {
          console.log(payload);
        }
        break;
      default:
        console.info({ ...payload, level });
    }
  };
}
