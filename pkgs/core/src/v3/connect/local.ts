import { LogLevel } from "../types/public/logs"
import type { LaunchedChrome } from "../types/public/launchedChrome"
import type { HandstageLocalOptions } from "../types/public/options"
import { CDPConnection, type CDPTransport } from "../understudy/cdp"
import type { V3 } from "../v3"
import { createOwnedHandstage, setupConnectContext } from "./shared"

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

	const reader = chrome.stdout.getReader()
	const writer = chrome.stdin.getWriter()
	const textDecoder = new TextDecoder()
	const textEncoder = new TextEncoder()

	let isClosed = false
	const transport: CDPTransport = {
		send: (message) => {
			if (isClosed) return
			writer.write(textEncoder.encode(`${message}\0`)).catch(() => {})
		},
		close: () => {
			if (isClosed) return
			isClosed = true
			writer.close().catch(() => {})
			const keepAlive = sharedOpts.keepAlive === true
			if (!keepAlive) {
				chrome.close().catch(() => {})
			}
		},
	}

	void (async () => {
		let buffer = ""
		try {
			while (!isClosed) {
				const { value, done } = await reader.read()
				if (done) break
				buffer += textDecoder.decode(value, { stream: true })

				let nullIdx = buffer.indexOf("\0")
				while (nullIdx !== -1) {
					const msg = buffer.slice(0, nullIdx)
					buffer = buffer.slice(nullIdx + 1)
					if (transport.onmessage) {
						transport.onmessage(msg)
					}
					nullIdx = buffer.indexOf("\0")
				}
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
