export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}
	return error === null || error === undefined ? "" : String(error)
}

export function isMissingTargetError(error: unknown): boolean {
	return /no target|target.*(?:closed|not found|does not exist|already gone)/i.test(
		errorMessage(error),
	)
}

export function isMissingBrowserContextError(error: unknown): boolean {
	return /failed to find browser context|browser context.*(?:not found|does not exist|already disposed)/i.test(
		errorMessage(error),
	)
}

export function isFrameScopeError(error: unknown): boolean {
	return /frame with the given|does not belong to the target|frame.*is not found/i.test(
		errorMessage(error),
	)
}

export function isMissingExecutionContextError(error: unknown): boolean {
	return /cannot find (?:default )?context with specified id|cannot find (?:default )?execution context|execution context (?:was )?destroyed|no execution context with given id/i.test(
		errorMessage(error),
	)
}

export function isTransientExecutionContextError(error: unknown): boolean {
	return (
		isMissingExecutionContextError(error) ||
		/inspected target navigated or closed/i.test(errorMessage(error))
	)
}

export function isTerminalRuntimeError(error: unknown): boolean {
	if (isTransientExecutionContextError(error)) {
		return false
	}
	return /session with given id not found|no target with given id|(?:session|target|connection|browser).*(?:closed|detached|crashed|not found|does not exist)/i.test(
		errorMessage(error),
	)
}
