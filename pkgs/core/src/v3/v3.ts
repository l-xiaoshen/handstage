import type { LogSink } from "./logger"
import { startShutdownSupervisor } from "./shutdown/supervisorClient"
import type {
	ShutdownSupervisorConfig,
	ShutdownSupervisorHandle,
} from "./types/private/shutdown"
import type { CreateContextOptions } from "./types/public/context"
import { LogLevel, type LogLine } from "./types/public/logs"
import type { HandstageSharedOptions } from "./types/public/options"
import type { CDPConnectionLike } from "./understudy/cdp"
import { V3Context } from "./understudy/context"
import type { Page } from "./understudy/page"

const V3_CONSTRUCTOR_TOKEN: unique symbol = Symbol("handstage.v3.constructor")

/**
 * V3 (alias `Handstage`)
 *
 * One V3 instance == one CDP connection + one root browser context.
 *
 * Connection lifecycle rules:
 *
 * - Factories in `@handstage/core/connect/*` decide whether V3 owns a
 *   connection and pass cleanup here.
 * - When cleanup is omitted, the caller remains responsible for the shared
 *   connection's lifetime after all attached V3 instances are closed.
 *
 * `V3Context` never closes the underlying CDP connection — that responsibility
 * lives here.
 */
export class V3 {
	private _isClosing = false

	private _onCDPClosed = (why: string) => {
		this._immediateShutdown(`CDP transport closed: ${why}`).catch(() => {})
	}

	/** Filtered logger built once at construction; passed down to V3Context. */
	private readonly logSink: LogSink
	public verbose: LogLevel
	private readonly instanceId: string
	private readonly sessionId: string
	private shutdownSupervisor: ShutdownSupervisorHandle | null = null
	private connection: CDPConnectionLike | null
	private readonly cleanup?: () => Promise<void>
	private readonly _contexts = new Set<V3Context>()
	private readonly defaultContext: V3Context

	/** @internal Use connection subpath factories instead. */
	constructor(
		token: typeof V3_CONSTRUCTOR_TOKEN,
		connection: CDPConnectionLike,
		cleanup: (() => Promise<void>) | undefined,
		defaultContext: V3Context,
		opts: HandstageSharedOptions,
		instanceId: string,
		logSink: LogSink,
		shutdownSupervisorConfig?: ShutdownSupervisorConfig,
	) {
		if (token !== V3_CONSTRUCTOR_TOKEN) {
			throw new TypeError(
				"Use @handstage/core/connect/* factories to create V3",
			)
		}

		this.connection = connection
		this.cleanup = cleanup
		this.defaultContext = defaultContext
		this._contexts.add(this.defaultContext)

		this.logSink = logSink
		this.verbose = opts.verbose ?? LogLevel.Info
		this.instanceId = instanceId
		this.sessionId = opts.sessionId ?? this.instanceId

		this.connection.onTransportClosed(this._onCDPClosed)
		if (shutdownSupervisorConfig) {
			this.startShutdownSupervisor(shutdownSupervisorConfig)
		}
	}

	private emitLog(line: LogLine): void {
		this.logSink(line)
	}

	private async _immediateShutdown(reason: string): Promise<void> {
		try {
			this.logger({
				category: "v3",
				message: `initiating shutdown → ${reason}`,
				level: LogLevel.Error,
			})
		} catch {}

		try {
			this.logger({
				category: "v3",
				message: `closing resources → ${reason}`,
				level: LogLevel.Error,
			})
			await this.close({ force: true })
		} catch {}
	}

	/** Spawn a crash-only supervisor that cleans up when this process dies. */
	private startShutdownSupervisor(
		config: ShutdownSupervisorConfig,
	): ShutdownSupervisorHandle | null {
		if (this.shutdownSupervisor) return this.shutdownSupervisor
		this.shutdownSupervisor = startShutdownSupervisor(config, {
			onError: (error, context) => {
				try {
					this.logger({
						category: "v3",
						message:
							"Shutdown supervisor unavailable; crash cleanup disabled. " +
							"If this process exits unexpectedly, local Chrome may remain running when keepAlive=false.",
						level: LogLevel.Error,
						attributes: {
							context,
							error: error.message,
						},
					})
				} catch {}
			},
		})
		return this.shutdownSupervisor
	}

	/** Stop the supervisor during a normal shutdown. */
	private stopShutdownSupervisor(): void {
		if (!this.shutdownSupervisor) return
		try {
			this.shutdownSupervisor.stop()
		} catch {}
		this.shutdownSupervisor = null
	}

	/** Expose the root default browser context. */
	public defaultBrowserContext(): V3Context {
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
	): Promise<V3Context> {
		if (!this.connection) {
			throw new Error("Cannot create browser context: V3 instance is closed")
		}
		const ctx = await V3Context.createIsolatedFromConnection(this.connection, {
			createOptions: options,
			logger: this.logSink,
		})
		this._contexts.add(ctx)
		return ctx
	}

	/**
	 * Returns an array of all open browser contexts.
	 * In a newly created browser, this will return a single instance of the default browser context.
	 */
	public browserContexts(): V3Context[] {
		const contexts: V3Context[] = []
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
		if (this._isClosing && !opts?.force) return
		this._isClosing = true

		try {
			if (this.connection && this._onCDPClosed) {
				this.connection.offTransportClosed?.(this._onCDPClosed)
			}
		} catch {}

		try {
			try {
				const closes = []
				for (const ctx of this._contexts) {
					closes.push(ctx.close())
				}
				await Promise.allSettled(closes)
			} catch {}

			await this.cleanup?.()
		} finally {
			this.stopShutdownSupervisor()

			this._contexts.clear()
			this.connection = null
			this._isClosing = false
		}
	}

	public get logger(): (logLine: LogLine) => void {
		return (logLine: LogLine) => {
			this.emitLog(logLine)
		}
	}
}

/** @internal Used by connection subpath factories. */
export function createV3ForConnection(params: {
	connection: CDPConnectionLike
	cleanup?: () => Promise<void>
	defaultContext: V3Context
	opts: HandstageSharedOptions
	instanceId: string
	logSink: LogSink
	shutdownSupervisorConfig?: ShutdownSupervisorConfig
}): V3 {
	return new V3(
		V3_CONSTRUCTOR_TOKEN,
		params.connection,
		params.cleanup,
		params.defaultContext,
		params.opts,
		params.instanceId,
		params.logSink,
		params.shutdownSupervisorConfig,
	)
}
