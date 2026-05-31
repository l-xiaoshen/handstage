import type { Handstage } from "../handstage"
import { LogLevel } from "../types/public/logs"
import type { HandstageConnectOptions } from "../types/public/options"
import {
	type ExternalCDPSession,
	ExternalConnectionAdapter,
} from "../understudy/cdp"
import {
	connectOptionsToLocalBrowserLaunchOptions,
	createOwnedHandstage,
	setupConnectContext,
} from "./shared"

export async function connectSession(
	session: ExternalCDPSession,
	opts?: HandstageConnectOptions,
): Promise<Handstage> {
	const { sharedOpts, logSink, logger } = setupConnectContext(opts)
	logger({
		category: "init",
		message: "Connecting via custom connection",
		level: LogLevel.Info,
	})

	const adapter = new ExternalConnectionAdapter(session)
	return await createOwnedHandstage({
		conn: adapter,
		lbo: connectOptionsToLocalBrowserLaunchOptions(opts),
		sharedOpts,
		logSink,
	})
}
