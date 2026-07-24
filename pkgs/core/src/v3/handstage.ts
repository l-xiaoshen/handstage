import type { LogSink } from "./logger"
import type { CreateContextOptions } from "./types/public/context"
import { LogLevel, type LogLine } from "./types/public/logs"
import type { HandstageSharedOptions } from "./types/public/options"
import { CDPConnectionClosedError } from "./types/public/sdkErrors"
import type { CDPConnectionLike } from "./understudy/cdp"
import { Context } from "./understudy/context"
import type { Page } from "./understudy/page"

const HANDSTAGE_CONSTRUCTOR_TOKEN: unique symbol = Symbol(
	"handstage.constructor",
)

/**
 * Handstage
 *
 * One Handstage instance == one CDP connection + one root browser context.
 *
 * Connection lifecycle rules:
 *
 * - Factories in `@handstage/core/connect/*` decide whether Handstage owns a
 *   connection and pass cleanup here.
 * - When cleanup is omitted, the caller remains responsible for the shared
 *   connection's lifetime after all attached Handstage instances are closed.
 *
 * `Context` never closes the underlying CDP connection — that responsibility
 * lives here.
 */
export class Handstage {
	private _isClosing = false
	private _closePromise: Promise<void> | null = null
	private _forceCloseRequested = false

	private _onCDPClosed = (why: string) => {
		this._immediateShutdown(`CDP transport closed: ${why}`).catch(() => {})
	}

	/** Filtered logger built once at construction; passed down to Context. */
	private readonly logSink: LogSink
	public verbose: LogLevel
	private connection: CDPConnectionLike | null
	private cleanup?: () => Promise<void>
	private readonly _contexts = new Set<Context>()
	private readonly pendingContextCreations = new Set<Promise<Context>>()
	private readonly contextCreationController = new AbortController()
	private defaultContext: Context | null

	/** @internal Use connection subpath factories instead. */
	constructor(
		token: typeof HANDSTAGE_CONSTRUCTOR_TOKEN,
		connection: CDPConnectionLike,
		cleanup: (() => Promise<void>) | undefined,
		defaultContext: Context,
		opts: HandstageSharedOptions,
		logSink: LogSink,
	) {
		if (token !== HANDSTAGE_CONSTRUCTOR_TOKEN) {
			throw new TypeError(
				"Use @handstage/core/connect/* factories to create Handstage",
			)
		}

		this.connection = connection
		this.cleanup = cleanup
		this.defaultContext = defaultContext
		this._trackContext(this.defaultContext)

		this.logSink = logSink
		this.verbose = opts.verbose ?? LogLevel.Info

		this.connection.onTransportClosed(this._onCDPClosed)
	}

	private emitLog(line: LogLine): void {
		this.logSink(line)
	}

	/** Track a context and drop it from the registry once it closes. */
	private _trackContext(ctx: Context): void {
		this._contexts.add(ctx)
		ctx.registerOnCloseCallback(() => {
			this._contexts.delete(ctx)
		})
	}

	private async _immediateShutdown(reason: string): Promise<void> {
		try {
			this.logger({
				category: "handstage",
				message: `initiating shutdown → ${reason}`,
				level: LogLevel.Error,
			})
		} catch {}

		try {
			this.logger({
				category: "handstage",
				message: `closing resources → ${reason}`,
				level: LogLevel.Error,
			})
			await this.close({ force: true })
		} catch {}
	}

	/** Expose the root default browser context. */
	public defaultBrowserContext(): Context {
		if (!this.defaultContext) {
			throw new CDPConnectionClosedError("Handstage instance is closed")
		}
		return this.defaultContext
	}

	/**
	 * Create a new isolated browser context (similar to an incognito profile).
	 *
	 * The returned context shares the underlying CDP connection but has its
	 * own cookies, storage, and pages. By default `disposeOnDetach: true` is
	 * set so Chrome auto-cleans the context on disconnect.
	 *
	 * @example
	 * import { connectLocal } from "@handstage/core/connect/local"
	 *
	 * const handstage = await connectLocal(chrome)
	 * const isolated = await handstage.createBrowserContext({ disposeOnDetach: true })
	 * await isolated.newPage("https://example.com")
	 * await isolated.close()
	 */
	public async createBrowserContext(
		options?: CreateContextOptions,
	): Promise<Context> {
		if (this._isClosing || !this.connection) {
			throw new CDPConnectionClosedError(
				"Cannot create browser context: Handstage instance is closed",
			)
		}
		const connection = this.connection
		const operation = (async () => {
			const ctx = await Context.createIsolatedFromConnection(connection, {
				createOptions: options,
				logger: this.logSink,
				signal: this.contextCreationController.signal,
			})
			this._trackContext(ctx)
			if (this._isClosing || this.connection !== connection) {
				const closedError = new CDPConnectionClosedError(
					"Cannot create browser context: Handstage instance is closed",
				)
				try {
					await ctx.close()
				} catch (cleanupError) {
					throw new AggregateError(
						[closedError, cleanupError],
						"Handstage closed while creating a browser context",
						{ cause: closedError },
					)
				}
				throw closedError
			}
			return ctx
		})()
		this.pendingContextCreations.add(operation)
		try {
			return await operation
		} finally {
			this.pendingContextCreations.delete(operation)
		}
	}

	/**
	 * Returns an array of all open browser contexts.
	 * In a newly created browser, this will return a single instance of the default browser context.
	 */
	public browserContexts(): Context[] {
		const contexts: Context[] = []
		for (const ctx of this._contexts) {
			contexts.push(ctx)
		}
		return contexts
	}

	/**
	 * Create a new page in the default browser context.
	 */
	public async newPage(url?: string): Promise<Page> {
		return this.defaultBrowserContext().newPage(url)
	}

	/**
	 * Returns an array of all pages across all browser contexts.
	 */
	public pages(): Page[] {
		const allPages: Page[] = []
		for (const ctx of this._contexts) {
			allPages.push(...ctx.pages())
		}
		return allPages
	}

	/** Best-effort cleanup of context and launched resources. */
	async close(opts?: { force?: boolean }): Promise<void> {
		if (opts?.force) {
			this._forceCloseRequested = true
		}
		if (this._closePromise) {
			return this._closePromise
		}
		this._isClosing = true
		if (!this.contextCreationController.signal.aborted) {
			this.contextCreationController.abort(
				new CDPConnectionClosedError("Handstage instance is closing"),
			)
		}

		const operation = (async () => {
			const cleanup = this.cleanup
			const closeErrors: unknown[] = []
			const failedContexts: Context[] = []
			let cleanupCompleted = false
			await Promise.allSettled([...this.pendingContextCreations])
			const contexts = [...this._contexts]
			const results = await Promise.allSettled(
				contexts.map((ctx) => ctx.close()),
			)
			for (const [index, result] of results.entries()) {
				if (result.status !== "rejected") {
					continue
				}
				closeErrors.push(result.reason)
				const context = contexts[index]
				if (context) {
					failedContexts.push(context)
				}
			}
			if (closeErrors.length > 0 && !this._forceCloseRequested) {
				if (closeErrors.length === 1) {
					throw closeErrors[0]
				}
				throw new AggregateError(
					closeErrors,
					"Failed to close Handstage contexts",
				)
			}
			try {
				if (this.connection && this._onCDPClosed) {
					this.connection.offTransportClosed?.(this._onCDPClosed)
				}
			} catch {}
			if (cleanup) {
				try {
					await cleanup()
					cleanupCompleted = true
				} catch (error) {
					closeErrors.push(error)
				}
			}

			if (closeErrors.length === 0) {
				this._contexts.clear()
				this.pendingContextCreations.clear()
				this.connection = null
				this.defaultContext = null
				this.cleanup = undefined
				return
			}

			if (cleanupCompleted || (this._forceCloseRequested && !cleanup)) {
				for (const context of failedContexts) {
					context.forceLocalFinalize()
				}
				this._contexts.clear()
				this.pendingContextCreations.clear()
				this.connection = null
				this.defaultContext = null
				this.cleanup = undefined
			} else {
				this._contexts.clear()
				for (const context of failedContexts) {
					this._contexts.add(context)
				}
			}
			if (closeErrors.length === 1) {
				throw closeErrors[0]
			}
			throw new AggregateError(
				closeErrors,
				"Failed to close Handstage resources",
			)
		})()
		this._closePromise = operation
		try {
			await operation
		} catch (error) {
			this._closePromise = null
			throw error
		}
	}

	public get logger(): (logLine: LogLine) => void {
		return (logLine: LogLine) => {
			this.emitLog(logLine)
		}
	}
}

/** @internal Used by connection subpath factories. */
export function createHandstageForConnection(params: {
	connection: CDPConnectionLike
	cleanup?: () => Promise<void>
	defaultContext: Context
	opts: HandstageSharedOptions
	logSink: LogSink
}): Handstage {
	return new Handstage(
		HANDSTAGE_CONSTRUCTOR_TOKEN,
		params.connection,
		params.cleanup,
		params.defaultContext,
		params.opts,
		params.logSink,
	)
}
