import { LogLevel } from "../types/public/logs"
import type { HandstageConnectOptions } from "../types/public/options"
import type { CDPConnectionLike } from "../understudy/cdp"
import type { V3 } from "../v3"
import {
	connectOptionsToLocalBrowserLaunchOptions,
	createSharedHandstage,
	setupConnectContext,
} from "./shared"

/**
 * Attach a V3 instance to a pre-existing `CDPConnectionLike` that the caller
 * manages. V3 will not close the shared connection on `close()`.
 */
export async function connectConnection(
	conn: CDPConnectionLike,
	opts?: HandstageConnectOptions,
): Promise<V3> {
	const { instanceId, sharedOpts, logSink, logger } = setupConnectContext(opts)
	logger({
		category: "init",
		message: "Attaching to shared CDP connection",
		level: LogLevel.Info,
	})

	return await createSharedHandstage({
		conn,
		lbo: connectOptionsToLocalBrowserLaunchOptions(opts),
		sharedOpts,
		instanceId,
		logSink,
	})
}
