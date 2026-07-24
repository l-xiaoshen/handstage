import { TimeoutError } from "../types/public/sdkErrors"
import { raceAgainstSignal } from "./abortUtils"
import { raceCleanupAgainstAbort } from "./runtimeObjectUtils"

const SCREENSHOT_CLEANUP_TIMEOUT_MS = 1000

export type ScreenshotCleanup = (signal?: AbortSignal) => Promise<void> | void

export async function runScreenshotCleanups(
	cleanups: ScreenshotCleanup[],
	signal?: AbortSignal,
): Promise<void> {
	await Promise.allSettled(
		[...cleanups].reverse().map(async (cleanup) => {
			try {
				await cleanup(signal)
			} catch {}
		}),
	)
}

export async function rollbackScreenshotCleanup(
	cleanup: ScreenshotCleanup,
	operationSignal?: AbortSignal,
): Promise<void> {
	const controller = new AbortController()
	const timer = setTimeout(
		() => controller.abort(new Error("Screenshot rollback timed out")),
		SCREENSHOT_CLEANUP_TIMEOUT_MS,
	)
	const operation = (async () => {
		try {
			await cleanup(controller.signal)
		} catch {
		} finally {
			clearTimeout(timer)
		}
	})()
	await raceCleanupAgainstAbort(operation, operationSignal)
}

export class ScreenshotCleanupScope {
	public readonly signal: AbortSignal
	private readonly cleanups: ScreenshotCleanup[] = []
	private readonly timeoutTimer: ReturnType<typeof setTimeout> | null
	private cleanupPromise: Promise<void> | null = null

	constructor(parentSignal: AbortSignal, timeoutMs?: number) {
		const timeoutController = new AbortController()
		this.signal = AbortSignal.any([parentSignal, timeoutController.signal])
		this.timeoutTimer =
			typeof timeoutMs === "number" &&
			Number.isFinite(timeoutMs) &&
			timeoutMs > 0
				? setTimeout(
						() =>
							timeoutController.abort(
								new TimeoutError("screenshot", timeoutMs),
							),
						timeoutMs,
					)
				: null
	}

	public async install(pending: Promise<ScreenshotCleanup>): Promise<void> {
		const cleanup = await pending
		this.cleanups.push(cleanup)
		this.signal.throwIfAborted()
	}

	public async close(): Promise<void> {
		const cleanup = this.drain()
		await raceAgainstSignal(cleanup, this.signal, "Screenshot aborted")
		this.signal.throwIfAborted()
	}

	public dispose(): void {
		if (this.timeoutTimer) {
			clearTimeout(this.timeoutTimer)
		}
	}

	private drain(): Promise<void> {
		this.cleanupPromise ??= (async () => {
			const controller = new AbortController()
			const timer = setTimeout(
				() =>
					controller.abort(
						new TimeoutError(
							"screenshot cleanup",
							SCREENSHOT_CLEANUP_TIMEOUT_MS,
						),
					),
				SCREENSHOT_CLEANUP_TIMEOUT_MS,
			)
			try {
				await runScreenshotCleanups(this.cleanups.splice(0), controller.signal)
			} finally {
				clearTimeout(timer)
			}
		})()
		return this.cleanupPromise
	}
}
