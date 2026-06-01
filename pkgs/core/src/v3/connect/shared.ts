import { createHandstageForConnection, type Handstage } from "../handstage"
import { createFilteredLogger, type LogSink } from "../logger"
import type {
	HandstageConnectOptions,
	HandstageSharedOptions,
	LocalBrowserLaunchOptions,
} from "../types/public/options"
import type { CDPConnectionLike } from "../understudy/cdp"
import { Context } from "../understudy/context"

export function setupConnectContext(opts?: HandstageSharedOptions) {
	const sharedOpts: HandstageSharedOptions = opts ?? {}
	const logSink = createFilteredLogger(sharedOpts.logger, sharedOpts.verbose)
	const logger: LogSink = (line) => logSink(line)
	return { sharedOpts, logSink, logger }
}

export function connectOptionsToLocalBrowserLaunchOptions(
	opts?: HandstageConnectOptions,
): LocalBrowserLaunchOptions {
	return opts
		? {
				viewport: opts.viewport,
				deviceScaleFactor: opts.deviceScaleFactor,
				downloadsPath: opts.downloadsPath,
				acceptDownloads: opts.acceptDownloads,
			}
		: {}
}

export function onceAsync(fn: () => Promise<void>): () => Promise<void> {
	let called = false
	return async () => {
		if (called) return
		called = true
		await fn()
	}
}

export async function createOwnedHandstage(params: {
	conn: CDPConnectionLike
	lbo: LocalBrowserLaunchOptions
	sharedOpts: HandstageSharedOptions
	logSink: LogSink
	onContextError?: () => Promise<void>
}): Promise<Handstage> {
	let ctx: Context
	try {
		ctx = await Context.createFromConnection(params.conn, {
			localBrowserLaunchOptions: params.lbo,
			logger: params.logSink,
		})
	} catch (err) {
		await params.conn.close().catch(() => {})
		await params.onContextError?.()
		throw err
	}

	const cleanup = onceAsync(async () => {
		await params.conn.close().catch(() => {})
	})
	const handstage = createHandstageForConnection({
		connection: params.conn,
		cleanup,
		defaultContext: ctx,
		opts: params.sharedOpts,
		logSink: params.logSink,
	})
	await applyPostConnectLocalOptions(handstage, params.lbo)
	return handstage
}

export async function createSharedHandstage(params: {
	conn: CDPConnectionLike
	lbo: LocalBrowserLaunchOptions
	sharedOpts: HandstageSharedOptions
	logSink: LogSink
}): Promise<Handstage> {
	const ctx = await Context.createFromConnection(params.conn, {
		localBrowserLaunchOptions: params.lbo,
		logger: params.logSink,
	})
	const handstage = createHandstageForConnection({
		connection: params.conn,
		defaultContext: ctx,
		opts: params.sharedOpts,
		logSink: params.logSink,
	})
	await applyPostConnectLocalOptions(handstage, params.lbo)
	return handstage
}

async function applyPostConnectLocalOptions(
	handstage: Handstage,
	lbo: LocalBrowserLaunchOptions,
): Promise<void> {
	await handstage
		.defaultBrowserContext()
		.setDownloadBehavior({
			downloadPath: lbo.downloadsPath,
			acceptDownloads: lbo.acceptDownloads,
		})
		.catch(() => {})
}
