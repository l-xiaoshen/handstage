/// <reference types="bun" />
import Bun from "bun"
import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/options"
import {
	cleanupUserDataDir,
	performBrowserProcessCleanup,
	prepareChromeLaunchOptions,
} from "./utils"

export async function launchChromeBun(
	opts?: LocalBrowserLaunchOptions,
): Promise<LaunchedChrome> {
	const lbo = opts ?? {}
	const { chromePath, finalFlags, userDataDir, createdTemp } =
		prepareChromeLaunchOptions(lbo)

	const p = (() => {
		try {
			return Bun.spawn([chromePath, ...finalFlags], {
				stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
			})
		} catch (error) {
			cleanupUserDataDir(userDataDir, createdTemp, lbo)
			throw error
		}
	})()

	const fd3 = p.stdio[3] // Chrome's read pipe
	const fd4 = p.stdio[4] // Chrome's write pipe

	if (typeof fd3 !== "number" || typeof fd4 !== "number") {
		await performBrowserProcessCleanup(
			(signal) => p.kill(signal),
			p.exited,
			userDataDir,
			createdTemp,
			lbo,
			() => p.unref(),
		)
		throw new Error("Failed to map Chrome pipes to Bun stdio streams")
	}

	const fd3Writer = Bun.file(fd3).writer()
	const fd4Reader = Bun.file(fd4).stream()
	let endStdinPromise: Promise<void> | null = null
	const endStdin = (): Promise<void> => {
		if (endStdinPromise) {
			return endStdinPromise
		}
		try {
			endStdinPromise = Promise.resolve(fd3Writer.end()).then(() => {})
		} catch (error) {
			endStdinPromise = Promise.reject(error)
		}
		return endStdinPromise
	}

	const fd3Sink = new WritableStream<Uint8Array>({
		async write(chunk) {
			await fd3Writer.write(chunk)
			await fd3Writer.flush()
		},
		close() {
			return endStdin()
		},
		abort() {
			return endStdin()
		},
	})
	let stdinController!: TransformStreamDefaultController<Uint8Array>
	let stdoutController!: TransformStreamDefaultController<Uint8Array>
	const stdinPipe = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			stdinController = controller
		},
	})
	const stdoutPipe = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			stdoutController = controller
		},
	})
	const fd3Closed = stdinPipe.readable
		.pipeTo(fd3Sink)
		.catch(() => {})
		.then(async () => {
			await endStdin().catch(() => {})
		})
	const fd4Closed = fd4Reader.pipeTo(stdoutPipe.writable).catch(() => {})
	void fd3Closed.catch(() => {})
	void fd4Closed.catch(() => {})

	let closePromise: Promise<void> | null = null
	let streamsClosed = false
	const close = async (): Promise<void> => {
		if (closePromise) {
			return closePromise
		}
		const operation = (async () => {
			if (!streamsClosed) {
				streamsClosed = true
				const reason = new Error("Chrome closed")
				// Bun 1.3.14 can leave an asynchronously aborted pipeTo() waiting
				// forever on an idle read. Stream errors use its settling path.
				try {
					stdinController.error(reason)
				} catch {}
				try {
					stdoutController.error(reason)
				} catch {}
			}
			const errors: unknown[] = []
			try {
				await performBrowserProcessCleanup(
					(signal) => p.kill(signal),
					p.exited,
					userDataDir,
					createdTemp,
					lbo,
					() => p.unref(),
				)
			} catch (error) {
				errors.push(error)
			}
			for (const result of await Promise.allSettled([fd3Closed, fd4Closed])) {
				if (result.status === "rejected") {
					errors.push(result.reason)
				}
			}
			if (errors.length === 1) {
				throw errors[0]
			}
			if (errors.length > 1) {
				throw new AggregateError(errors, "Failed to close Chrome")
			}
		})()
		closePromise = operation
		try {
			await operation
		} catch (error) {
			if (closePromise === operation) {
				closePromise = null
			}
			throw error
		}
	}

	return {
		stdout: stdoutPipe.readable,
		stdin: stdinPipe.writable,
		close,
		pid: p.pid,
		userDataDir,
		createdTempProfile: createdTemp,
	}
}
