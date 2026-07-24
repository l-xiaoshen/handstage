import { createHandstageForConnection, type Handstage } from "../handstage"
import { createFilteredLogger, type LogSink } from "../logger"
import type {
	HandstageConnectOptions,
	HandstageSharedOptions,
	LocalBrowserLaunchOptions,
} from "../types/public/options"
import { TimeoutError } from "../types/public/sdkErrors"
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
	let promise: Promise<void> | null = null
	return () => {
		if (!promise) {
			const current = Promise.resolve().then(fn)
			promise = current
			void current.catch(() => {
				if (promise === current) {
					promise = null
				}
			})
		}
		return promise
	}
}

export async function createOwnedHandstage(params: {
	conn: CDPConnectionLike
	lbo: LocalBrowserLaunchOptions
	sharedOpts: HandstageSharedOptions
	logSink: LogSink
	onContextError?: () => Promise<void>
	/** @internal Allows lifecycle tests to exercise startup cancellation quickly. */
	initializationTimeoutMs?: number
	/** @internal Allows lifecycle tests to exercise bounded cleanup quickly. */
	cleanupTimeoutMs?: number
}): Promise<Handstage> {
	const initializationTimeoutMs = params.initializationTimeoutMs ?? 30_000
	const cleanupTimeoutMs = params.cleanupTimeoutMs ?? 2_000
	const initializationController = new AbortController()
	const initializationTimer = Number.isFinite(initializationTimeoutMs)
		? setTimeout(
				() =>
					initializationController.abort(
						new TimeoutError(
							"Handstage connection initialization",
							Math.max(0, initializationTimeoutMs),
						),
					),
				Math.max(0, initializationTimeoutMs),
			)
		: null
	const closeOwnedResources = onceAsync(async () => {
		const cleanupResults = await Promise.allSettled([
			Promise.resolve().then(() => params.conn.close()),
			...(params.onContextError
				? [Promise.resolve().then(params.onContextError)]
				: []),
		])
		const cleanupErrors: unknown[] = []
		for (const result of cleanupResults) {
			if (
				result.status === "rejected" &&
				!cleanupErrors.includes(result.reason)
			) {
				cleanupErrors.push(result.reason)
			}
		}
		if (cleanupErrors.length === 1) {
			throw cleanupErrors[0]
		}
		if (cleanupErrors.length > 1) {
			throw new AggregateError(
				cleanupErrors,
				"Failed to close owned Handstage resources",
			)
		}
	})
	let ctx: Context | null = null
	let handstage: Handstage | null = null
	try {
		ctx = await Context.createFromConnection(params.conn, {
			localBrowserLaunchOptions: params.lbo,
			logger: params.logSink,
			signal: initializationController.signal,
		})
		handstage = createHandstageForConnection({
			connection: params.conn,
			cleanup: closeOwnedResources,
			defaultContext: ctx,
			opts: params.sharedOpts,
			logSink: params.logSink,
		})
		await applyPostConnectLocalOptions(
			handstage,
			params.lbo,
			initializationController.signal,
		)
		return handstage
	} catch (err) {
		const cleanupErrors: unknown[] = []
		const initializedHandstage = handstage
		const initializedContext = ctx
		const cleanup = Promise.allSettled([
			...(initializedHandstage
				? [
						Promise.resolve().then(() =>
							initializedHandstage.close({ force: true }),
						),
					]
				: initializedContext
					? [Promise.resolve().then(() => initializedContext.close())]
					: []),
			closeOwnedResources(),
		]).then((results) => {
			const errors: unknown[] = []
			for (const result of results) {
				if (result.status !== "rejected") {
					continue
				}
				if (result.reason instanceof AggregateError) {
					for (const error of result.reason.errors) {
						if (!errors.includes(error)) {
							errors.push(error)
						}
					}
				} else if (!errors.includes(result.reason)) {
					errors.push(result.reason)
				}
			}
			if (errors.length === 1) {
				throw errors[0]
			}
			if (errors.length > 1) {
				throw new AggregateError(errors, "Failed initialization cleanup")
			}
		})
		let cleanupTimer: ReturnType<typeof setTimeout> | null = null
		try {
			if (Number.isFinite(cleanupTimeoutMs)) {
				await Promise.race([
					cleanup,
					new Promise<never>((_, reject) => {
						cleanupTimer = setTimeout(
							() =>
								reject(
									new TimeoutError(
										"Handstage initialization cleanup",
										Math.max(0, cleanupTimeoutMs),
									),
								),
							Math.max(0, cleanupTimeoutMs),
						)
					}),
				])
			} else {
				await cleanup
			}
		} catch (cleanupError) {
			if (cleanupError instanceof AggregateError) {
				cleanupErrors.push(...cleanupError.errors)
			} else {
				cleanupErrors.push(cleanupError)
			}
			try {
				params.conn.abandonOwnership?.()
			} catch (abandonError) {
				cleanupErrors.push(abandonError)
			}
		} finally {
			if (cleanupTimer) {
				clearTimeout(cleanupTimer)
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[err, ...cleanupErrors],
				"Failed to initialize Handstage and close its owned connection",
				{ cause: err },
			)
		}
		throw err
	} finally {
		if (initializationTimer) {
			clearTimeout(initializationTimer)
		}
	}
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
	signal?: AbortSignal,
): Promise<void> {
	const throwIfAborted = () => {
		if (!signal?.aborted) {
			return
		}
		throw signal.reason instanceof Error
			? signal.reason
			: new Error("Handstage connection initialization aborted")
	}
	throwIfAborted()
	if (lbo.downloadsPath === undefined && lbo.acceptDownloads === undefined) {
		return
	}

	const context = handstage.defaultBrowserContext()
	try {
		await context.setDownloadBehavior(
			{
				downloadPath: lbo.downloadsPath,
				acceptDownloads: lbo.acceptDownloads,
			},
			signal,
		)
	} catch (error) {
		if (signal?.aborted) {
			throw error
		}
	}
	throwIfAborted()
}
