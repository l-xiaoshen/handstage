export function abortError(
	signal: AbortSignal,
	fallbackMessage: string,
): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error(fallbackMessage)
}

export function raceAgainstSignal<T>(
	operation: PromiseLike<T>,
	signal: AbortSignal,
	fallbackMessage: string,
): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(abortError(signal, fallbackMessage))
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false
		const cleanup = () => signal.removeEventListener("abort", onAbort)
		const onAbort = () => {
			if (settled) {
				return
			}
			settled = true
			cleanup()
			reject(abortError(signal, fallbackMessage))
		}

		signal.addEventListener("abort", onAbort, { once: true })
		Promise.resolve(operation).then(
			(value) => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				resolve(value)
			},
			(error) => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				reject(error)
			},
		)
		if (signal.aborted) {
			onAbort()
		}
	})
}

export function delayWithSignal(
	delayMs: number,
	signal: AbortSignal,
	fallbackMessage: string,
): Promise<void> {
	if (signal.aborted) {
		return Promise.reject(abortError(signal, fallbackMessage))
	}

	return new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | null = setTimeout(
			() => {
				timer = null
				signal.removeEventListener("abort", onAbort)
				resolve()
			},
			Math.max(0, delayMs),
		)
		const onAbort = () => {
			if (timer === null) {
				return
			}
			clearTimeout(timer)
			timer = null
			signal.removeEventListener("abort", onAbort)
			reject(abortError(signal, fallbackMessage))
		}
		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) {
			onAbort()
		}
	})
}

export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (
		typeof timer !== "object" ||
		timer === null ||
		!("unref" in timer) ||
		typeof timer.unref !== "function"
	) {
		return
	}
	timer.unref()
}
