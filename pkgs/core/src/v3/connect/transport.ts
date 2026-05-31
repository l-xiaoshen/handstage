import type { Handstage } from "../handstage"
import { LogLevel } from "../types/public/logs"
import type { HandstageConnectOptions } from "../types/public/options"
import { CDPConnection, type CDPTransport } from "../understudy/cdp"
import {
	connectOptionsToLocalBrowserLaunchOptions,
	createOwnedHandstage,
	setupConnectContext,
} from "./shared"

export async function connectTransport(
	transport: CDPTransport,
	opts?: HandstageConnectOptions,
): Promise<Handstage> {
	const { instanceId, sharedOpts, logSink, logger } = setupConnectContext(opts)
	logger({
		category: "init",
		message: "Connecting via custom transport",
		level: LogLevel.Info,
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
