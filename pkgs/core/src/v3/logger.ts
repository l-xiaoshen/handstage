import { createConsoleLogger } from "./types/public/consoleLogger"
import { LogLevel, type LogLine, shouldEmitLogLine } from "./types/public/logs"

/**
 * Per-instance log routing for Handstage V3.
 *
 * There is no AsyncLocalStorage in this module — that approach lost scope
 * inside event-driven code paths (CDP transport callbacks fire outside any
 * parent async frame) and forced every event-time log to fall back to a
 * global console logger.  Instead, every class that emits debug lines now
 * accepts an explicit {@link LogSink} via its constructor and uses it
 * directly.  Multiple V3 instances therefore route their logs to their own
 * `HandstageSharedOptions.logger` without cross-talk.
 */
export type LogSink = (line: LogLine) => void

/**
 * Build a level-filtered logger from the caller-supplied logger (or a
 * console fallback).  Used by V3 at construction time to wrap the user's
 * raw logger into one that already respects `verbose`.
 */
export function createFilteredLogger(
	rawLogger: LogSink | undefined,
	verbose: LogLevel | undefined,
): LogSink {
	const sink = rawLogger ?? createConsoleLogger()
	const minLevel = verbose ?? LogLevel.Info
	return (line: LogLine) => {
		if (!shouldEmitLogLine(line.level, minLevel)) return
		sink({ ...line, level: line.level ?? LogLevel.Info })
	}
}

/**
 * Lazily-constructed console fallback used for code paths that fire before
 * a real logger is plumbed in (e.g. the few static utility functions that
 * still take an optional logger arg).
 */
let _defaultLogger: LogSink | null = null
export function defaultLogger(): LogSink {
	if (!_defaultLogger) {
		_defaultLogger = createFilteredLogger(undefined, LogLevel.Info)
	}
	return _defaultLogger
}
