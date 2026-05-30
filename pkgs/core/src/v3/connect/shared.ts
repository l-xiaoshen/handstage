import { v7 as uuidv7 } from "uuid"
import { createFilteredLogger, type LogSink } from "../logger"
import type { ShutdownSupervisorConfig } from "../types/private/shutdown"
import type {
	HandstageConnectOptions,
	HandstageSharedOptions,
	LocalBrowserLaunchOptions,
} from "../types/public/options"
import type { CDPConnectionLike } from "../understudy/cdp"
import { V3Context } from "../understudy/context"
import { V3 } from "../v3"

export function setupConnectContext(opts?: HandstageSharedOptions) {
	const instanceId = uuidv7()
	const sharedOpts: HandstageSharedOptions = opts ?? {}
	const logSink = createFilteredLogger(sharedOpts.logger, sharedOpts.verbose)
	const logger: LogSink = (line) => logSink(line)
	return { instanceId, sharedOpts, logSink, logger }
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
	instanceId: string
	logSink: LogSink
	onContextError?: () => Promise<void>
	shutdownSupervisorConfig?: ShutdownSupervisorConfig
}): Promise<V3> {
	let ctx: V3Context
	try {
		ctx = await V3Context.createFromConnection(params.conn, {
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
	const v3 = V3.createForConnection({
		connection: params.conn,
		cleanup,
		defaultContext: ctx,
		opts: params.sharedOpts,
		instanceId: params.instanceId,
		logSink: params.logSink,
		shutdownSupervisorConfig: params.shutdownSupervisorConfig,
	})
	await applyPostConnectLocalOptions(v3, params.lbo)
	return v3
}

export async function createSharedHandstage(params: {
	conn: CDPConnectionLike
	lbo: LocalBrowserLaunchOptions
	sharedOpts: HandstageSharedOptions
	instanceId: string
	logSink: LogSink
}): Promise<V3> {
	const ctx = await V3Context.createFromConnection(params.conn, {
		localBrowserLaunchOptions: params.lbo,
		logger: params.logSink,
	})
	const v3 = V3.createForConnection({
		connection: params.conn,
		defaultContext: ctx,
		opts: params.sharedOpts,
		instanceId: params.instanceId,
		logSink: params.logSink,
	})
	await applyPostConnectLocalOptions(v3, params.lbo)
	return v3
}

async function applyPostConnectLocalOptions(
	v3: V3,
	lbo: LocalBrowserLaunchOptions,
): Promise<void> {
	await v3
		.defaultBrowserContext()
		.setDownloadBehavior({
			downloadPath: lbo.downloadsPath,
			acceptDownloads: lbo.acceptDownloads,
		})
		.catch(() => {})
}
