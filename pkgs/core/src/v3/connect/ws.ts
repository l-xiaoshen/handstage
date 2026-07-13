import type { Handstage } from "../handstage"
import { LogLevel } from "../types/public/logs"
import type { HandstageConnectOptions } from "../types/public/options"
import { CDPConnection, createWebSocketTransport } from "../understudy/cdp"
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

	const conn = new CDPConnection(createWebSocketTransport(ws))
	return await createOwnedHandstage({
		conn,
		lbo: connectOptionsToLocalBrowserLaunchOptions(opts),
		sharedOpts,
		logSink,
	})
}
