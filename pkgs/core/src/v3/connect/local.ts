import type { LaunchedChrome } from "../types/public/launchedChrome"
import { LogLevel } from "../types/public/logs"
import type { HandstageLocalOptions } from "../types/public/options"
import { CDPConnection, type CDPTransport } from "../understudy/cdp"
import type { V3 } from "../v3"
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
			if (trailing) controller.enqueue(trailing)
		},
	})
}

async function* readNullDelimitedMessages(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const decodedStream = stream.pipeThrough(createUtf8DecoderStream())
	const reader = decodedStream.getReader()
	let pending = ""

	try {
		while (true) {
			const { value, done } = await reader.read()
			if (done) break

			pending += value
			let frameStart = 0

			while (true) {
				const frameEnd = pending.indexOf("\0", frameStart)
				if (frameEnd === -1) break

				yield pending.slice(frameStart, frameEnd)
				frameStart = frameEnd + 1
			}

			if (frameStart > 0) {
				pending = pending.slice(frameStart)
			}
		}
	} finally {
		reader.releaseLock()
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
): Promise<V3> {
	const { instanceId, sharedOpts, logSink, logger } = setupConnectContext(opts)
	logger({
		category: "init",
		message: "Connecting via LaunchedChrome (pipe)",
		level: LogLevel.Info,
	})

	const writer = chrome.stdin.getWriter()

	let isClosed = false
	const transport: CDPTransport = {
		send: (message) => {
			if (isClosed) return
			writer.write(encodeNullDelimitedMessage(message)).catch(() => {})
		},
		close: async () => {
			if (isClosed) return
			isClosed = true
			await writer.close().catch(() => {})
			const keepAlive = sharedOpts.keepAlive === true
			if (!keepAlive) {
				await chrome.close().catch(() => {})
			}
		},
	}

	void (async () => {
		try {
			for await (const message of readNullDelimitedMessages(chrome.stdout)) {
				if (isClosed) break
				if (transport.onmessage) transport.onmessage(message)
			}
		} catch (err) {
			if (transport.onerror) {
				transport.onerror(err instanceof Error ? err : new Error(String(err)))
			}
		} finally {
			if (transport.onclose && !isClosed) {
				transport.onclose("Pipe closed")
			}
			isClosed = true
		}
	})()

	const conn = new CDPConnection(transport)
	const lbo = opts?.localBrowserLaunchOptions ?? {}
	const keepAlive = sharedOpts.keepAlive === true

	return await createOwnedHandstage({
		conn,
		lbo,
		sharedOpts,
		instanceId,
		logSink,
		onContextError: async () => {
			await chrome.close().catch(() => {})
		},
		shutdownSupervisorConfig:
			!keepAlive && chrome.pid
				? {
						kind: "LOCAL",
						pid: chrome.pid,
						userDataDir: chrome.userDataDir,
						createdTempProfile: !!chrome.createdTempProfile,
						preserveUserDataDir: !!lbo.preserveUserDataDir,
					}
				: undefined,
	})
}
