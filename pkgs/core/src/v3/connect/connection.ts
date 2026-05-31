import type { Handstage } from "../handstage"
import { LogLevel } from "../types/public/logs"
import type { HandstageConnectOptions } from "../types/public/options"
import type { CDPConnectionLike } from "../understudy/cdp"
import {
	connectOptionsToLocalBrowserLaunchOptions,
	createSharedHandstage,
	setupConnectContext,
} from "./shared"

/**
 * Attach a Handstage instance to a pre-existing `CDPConnectionLike` that the caller
 * manages. Handstage will not close the shared connection on `close()`.
 */
export async function connectConnection(
	conn: CDPConnectionLike,
	opts?: HandstageConnectOptions,
): Promise<Handstage> {
	const { sharedOpts, logSink, logger } = setupConnectContext(opts)
	logger({
		category: "init",
		message: "Attaching to shared CDP connection",
		level: LogLevel.Info,
	})

	return await createSharedHandstage({
		conn,
		lbo: connectOptionsToLocalBrowserLaunchOptions(opts),
		sharedOpts,
		logSink,
	})
}
