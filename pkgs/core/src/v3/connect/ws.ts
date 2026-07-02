import type { Handstage } from "../handstage"
import { LogLevel } from "../types/public/logs"
import type { HandstageConnectOptions } from "../types/public/options"
import { CDPConnection, type CDPTransport } from "../understudy/cdp"
import {
	connectOptionsToLocalBrowserLaunchOptions,
	createOwnedHandstage,
	setupConnectContext,
} from "./shared"

export async function connectWS(
	ws: WebSocket,
	opts?: HandstageConnectOptions,
): Promise<Handstage> {
	const { sharedOpts, logSink, logger } = setupConnectContext(opts)
	logger({
		category: "init",
		message: "Connecting via WebSocket",
		level: LogLevel.Info,
	})

	const onMessage = (event: MessageEvent) => {
		if (transport.onmessage) transport.onmessage(event.data.toString())
	}
	const onClose = (event: CloseEvent) => {
		if (transport.onclose)
			transport.onclose(`code=${event.code} reason=${event.reason}`)
	}
	const onError = () => {
		if (transport.onerror) transport.onerror(new Error("WebSocket error"))
	}

	const transport: CDPTransport = {
		send: (message) => ws.send(message),
		close: () => {
			// Remove our listeners so the closure over `transport` (and the ws)
			// is released rather than lingering on the socket.
			ws.removeEventListener("message", onMessage)
			ws.removeEventListener("close", onClose)
			ws.removeEventListener("error", onError)
			ws.close()
		},
	}

	ws.addEventListener("message", onMessage)
	ws.addEventListener("close", onClose)
	ws.addEventListener("error", onError)

	const conn = new CDPConnection(transport)
	return await createOwnedHandstage({
		conn,
		lbo: connectOptionsToLocalBrowserLaunchOptions(opts),
		sharedOpts,
		logSink,
	})
}
