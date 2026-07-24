import type { Handstage } from "../handstage"
import type { LaunchedChrome } from "../types/public/launchedChrome"
import { LogLevel } from "../types/public/logs"
import type { HandstageLocalOptions } from "../types/public/options"
import { CDPConnection, type CDPTransport } from "../understudy/cdp"
import { errorMessage } from "../understudy/protocolError"
import { createOwnedHandstage, setupConnectContext } from "./shared"

const textEncoder = new TextEncoder()

function createUtf8DecoderStream(): TransformStream<Uint8Array, string> {
	const decoder = new TextDecoder()
	return new TransformStream<Uint8Array, string>({
		transform(chunk, controller) {
			controller.enqueue(decoder.decode(chunk, { stream: true }))
		},
		flush(controller) {
			const trailing = decoder.decode()
			if (trailing) {
				controller.enqueue(trailing)
			}
		},
	})
}

async function* readNullDelimitedMessages(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<string> {
	const decodedStream = stream.pipeThrough(createUtf8DecoderStream())
	const reader = decodedStream.getReader()
	let pending = ""
	const onAbort = () => {
		void reader.cancel(signal?.reason).catch(() => {})
	}
	signal?.addEventListener("abort", onAbort, { once: true })

	try {
		if (signal?.aborted) {
			onAbort()
		}
		while (true) {
			const { value, done } = await reader.read()
			if (done) {
				break
			}

			pending += value
			let frameStart = 0

			while (true) {
				const frameEnd = pending.indexOf("\0", frameStart)
				if (frameEnd === -1) {
					break
				}

				yield pending.slice(frameStart, frameEnd)
				frameStart = frameEnd + 1
			}

			if (frameStart > 0) {
				pending = pending.slice(frameStart)
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort)
		try {
			reader.releaseLock()
		} catch {}
	}
}

function encodeNullDelimitedMessage(message: string): Uint8Array {
	const encoded = textEncoder.encode(message)
	const framed = new Uint8Array(encoded.byteLength + 1)
	framed.set(encoded)
	return framed
}

export async function connectLocal(
	chrome: LaunchedChrome,
	opts?: HandstageLocalOptions,
): Promise<Handstage> {
	const closeAfterInitFailure = async (error: unknown): Promise<never> => {
		try {
			await chrome.close()
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Failed to initialize the Chrome pipe and close Chrome",
				{ cause: error },
			)
		}
		throw error
	}

	let connectContext: ReturnType<typeof setupConnectContext>
	try {
		connectContext = setupConnectContext(opts)
		connectContext.logger({
			category: "init",
			message: "Connecting via LaunchedChrome (pipe)",
			level: LogLevel.Info,
		})
	} catch (error) {
		return await closeAfterInitFailure(error)
	}
	const { sharedOpts, logSink, logger } = connectContext

	let writer: WritableStreamDefaultWriter<Uint8Array>
	try {
		writer = chrome.stdin.getWriter()
	} catch (error) {
		return await closeAfterInitFailure(error)
	}

	let pipeClosed = false
	const pipeController = new AbortController()
	let closePromise: Promise<void> | null = null
	let closeErrorLogged = false
	let writerReleased = false
	const releaseWriter = (): void => {
		if (writerReleased) {
			return
		}
		try {
			writer.releaseLock()
			writerReleased = true
		} catch {}
	}
	const logCloseError = (error: unknown): void => {
		if (closeErrorLogged) {
			return
		}
		closeErrorLogged = true
		try {
			logger({
				category: "init",
				message: "Failed to release Chrome pipe resources",
				level: LogLevel.Error,
				attributes: {
					error: errorMessage(error),
				},
			})
		} catch {}
	}
	const closeResources = (): Promise<void> => {
		if (closePromise) {
			return closePromise
		}
		pipeClosed = true
		if (!pipeController.signal.aborted) {
			pipeController.abort(new Error("Chrome pipe closed"))
		}
		const operation = (async () => {
			let chromeClose: Promise<void>
			try {
				chromeClose = chrome.close()
			} catch (error) {
				chromeClose = Promise.reject(error)
			}

			let abortResult: Promise<void> | null = null
			try {
				abortResult = writer.abort()
			} catch {}
			if (abortResult) {
				void abortResult.catch(() => {}).then(releaseWriter)
			}
			releaseWriter()

			try {
				await chromeClose
			} finally {
				releaseWriter()
			}
		})()
		closePromise = operation
		void operation.catch(() => {
			if (closePromise === operation) {
				closePromise = null
			}
		})
		return operation
	}
	const transport: CDPTransport = {
		send: (message) => {
			if (pipeClosed) {
				return
			}
			void writer
				.write(encodeNullDelimitedMessage(message))
				.catch(terminalizeTransport)
		},
		close: closeResources,
	}
	function terminalizeTransport(error: unknown): void {
		if (pipeClosed) {
			return
		}
		const cleanup = closeResources()
		try {
			transport.onerror?.(
				error instanceof Error ? error : new Error(String(error)),
			)
		} catch {}
		void cleanup.catch(logCloseError)
	}

	void (async () => {
		try {
			for await (const message of readNullDelimitedMessages(
				chrome.stdout,
				pipeController.signal,
			)) {
				if (pipeClosed) {
					break
				}
				if (transport.onmessage) {
					transport.onmessage(message)
				}
			}
		} catch (err) {
			terminalizeTransport(err)
		} finally {
			const notifyClose = !pipeClosed
			const cleanup = closeResources()
			try {
				if (notifyClose) {
					transport.onclose?.("Pipe closed")
				}
			} catch {}
			await cleanup.catch(logCloseError)
		}
	})()

	const conn = new CDPConnection(transport)
	const lbo = opts?.localBrowserLaunchOptions ?? {}

	return await createOwnedHandstage({
		conn,
		lbo,
		sharedOpts,
		logSink,
		onContextError: closeResources,
	})
}
