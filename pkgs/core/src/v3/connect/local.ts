import { registerBrowserForCleanup } from "../../launch/exitSupervisor"
import type { Handstage } from "../handstage"
import type { LaunchedChrome } from "../types/public/launchedChrome"
import { LogLevel } from "../types/public/logs"
import type { HandstageLocalOptions } from "../types/public/options"
import { CDPConnection, type CDPTransport } from "../understudy/cdp"
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
): Promise<Handstage> {
	const { sharedOpts, logSink, logger } = setupConnectContext(opts)
	logger({
		category: "init",
		message: "Connecting via LaunchedChrome (pipe)",
		level: LogLevel.Info,
	})

	const writer = chrome.stdin.getWriter()

	// Register with the crash-supervisor so an unexpected host exit force-kills
	// the browser and removes its temp profile. Deregistered in transport.close()
	// once the browser is gone, so we never kill a recycled PID.
	const deregisterCleanup = registerBrowserForCleanup({
		pid: chrome.pid,
		userDataDir: chrome.userDataDir,
		createdTemp: chrome.createdTempProfile ?? false,
		preserveUserDataDir: opts?.localBrowserLaunchOptions?.preserveUserDataDir,
	})

	let isClosed = false
	// Tracked separately from `isClosed` so `onclose` fires exactly once whether
	// the close is graceful (`close()`) or spontaneous (pipe end/error). Gating
	// on `!isClosed` alone would skip notifying on a graceful close.
	let notifiedClose = false
	const notifyClose = (reason: string): void => {
		if (notifiedClose) return
		notifiedClose = true
		transport.onclose?.(reason)
	}
	const transport: CDPTransport = {
		send: (message) => {
			if (isClosed) return
			writer.write(encodeNullDelimitedMessage(message)).catch(() => {})
		},
		close: async () => {
			if (isClosed) return
			isClosed = true
			await writer.close().catch(() => {})
			await chrome.close().catch(() => {})
			// Browser is gone (or best-effort closed) — stop supervising it.
			deregisterCleanup()
			notifyClose("transport closed")
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
			isClosed = true
			notifyClose("Pipe closed")
		}
	})()

	try {
		const conn = new CDPConnection(transport)
		const lbo = opts?.localBrowserLaunchOptions ?? {}

		return await createOwnedHandstage({
			conn,
			lbo,
			sharedOpts,
			logSink,
			onContextError: async () => {
				await chrome.close().catch(() => {})
			},
		})
	} catch (err) {
		// Guard the rarer failure paths (e.g. CDPConnection construction) so a
		// failed connect never leaves a supervised entry. Idempotent disposer.
		deregisterCleanup()
		throw err
	}
}
