/**
 * Severity for Stagehand log lines. Maps 1:1 to `console.error` / `console.info` / `console.debug`.
 */
export enum LogLevel {
  Error = "error",
  Info = "info",
  Debug = "debug",
}

/** Numeric rank for filtering: lower = higher priority (always show Error first). */
export function logLevelRank(level: LogLevel): number {
  switch (level) {
    case LogLevel.Error:
      return 0;
    case LogLevel.Info:
      return 1;
    case LogLevel.Debug:
      return 2;
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

/** Emit `line` when its severity is at or below the configured verbosity threshold. */
export function shouldEmitLogLine(
  lineLevel: LogLevel | undefined,
  verbose: LogLevel,
): boolean {
  const line = lineLevel ?? LogLevel.Info;
  return logLevelRank(line) <= logLevelRank(verbose);
}

export type LogLine = {
  id?: string;
  category?: string;
  message: string;
  level?: LogLevel;
  timestamp?: string;
  /** Arbitrary structured fields (OTel-style attributes, debugging context, etc.) */
  attributes?: Record<string, unknown>;
  /** W3C trace id (32 hex chars), for correlation with traces / OTel. */
  traceId?: string;
  /** W3C span id (16 hex chars). */
  spanId?: string;
  /** W3C trace flags (2 hex chars), optional. */
  traceFlags?: string;
};

export type Logger = (logLine: LogLine) => void;
