import { AsyncLocalStorage } from "node:async_hooks"
import { createConsoleLogger } from "./types/public/consoleLogger"
import type { LogLine } from "./types/public/logs"

/**
 * Stagehand V3 per-instance log routing (AsyncLocalStorage).
 *
 * - `bindInstanceLogger` / `unbindInstanceLogger`: register the effective logger for an instance id.
 * - `withInstanceLogContext`: run a function with that instance id on the async context.
 * - `v3Logger`: emit a line for the current instance, or fall back to `createConsoleLogger()` when no context.
 */

const logContext = new AsyncLocalStorage<string>()
const instanceLoggers = new Map<string, (line: LogLine) => void>()

const fallbackLogger = createConsoleLogger()

export function bindInstanceLogger(
	instanceId: string,
	logger: (line: LogLine) => void,
): void {
	instanceLoggers.set(instanceId, logger)
}

export function unbindInstanceLogger(instanceId: string): void {
	instanceLoggers.delete(instanceId)
}

export function withInstanceLogContext<T>(instanceId: string, fn: () => T): T {
	return logContext.run(instanceId, fn)
}

export function v3Logger(line: LogLine): void {
	const id = logContext.getStore()
	if (id) {
		const fn = instanceLoggers.get(id)
		if (fn) {
			try {
				fn(line)
				return
			} catch {
				// fall through to fallback
			}
		}
	}

	fallbackLogger(line)
}
