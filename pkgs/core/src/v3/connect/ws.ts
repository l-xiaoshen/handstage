import { LogLevel } from "../types/public/logs"
import type { HandstageConnectOptions } from "../types/public/options"
import { CDPConnection, type CDPTransport } from "../understudy/cdp"
import type { V3 } from "../v3"
import {
	connectOptionsToLocalBrowserLaunchOptions,
	createOwnedHandstage,
	setupConnectContext,
} from "./shared"

export async function connectWS(
	ws: WebSocket,
	opts?: HandstageConnectOptions,
): Promise<V3> {
	const { instanceId, sharedOpts, logSink, logger } = setupConnectContext(opts)
	logger({
		category: "init",
		message: "Connecting via WebSocket",
		level: LogLevel.Info,
	})

	const transport: CDPTransport = {
		send: (message) => ws.send(message),
		close: () => ws.close(),
	}

	ws.addEventListener("message", (event) => {
		if (transport.onmessage) transport.onmessage(event.data.toString())
	})
	ws.addEventListener("close", (event) => {
		if (transport.onclose)
			transport.onclose(`code=${event.code} reason=${event.reason}`)
	})
	ws.addEventListener("error", () => {
		if (transport.onerror) transport.onerror(new Error("WebSocket error"))
	})

	const conn = new CDPConnection(transport)
	return await createOwnedHandstage({
		conn,
		lbo: connectOptionsToLocalBrowserLaunchOptions(opts),
		sharedOpts,
		instanceId,
		logSink,
	})
}
