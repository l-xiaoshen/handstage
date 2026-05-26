import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { v7 as uuidv7 } from "uuid"
import { createFilteredLogger, type LogSink } from "./logger"
import { startShutdownSupervisor } from "./shutdown/supervisorClient"
import type {
	ShutdownSupervisorConfig,
	ShutdownSupervisorHandle,
} from "./types/private/shutdown"
import type { CreateContextOptions } from "./types/public/context"
import { LogLevel, type LogLine } from "./types/public/logs"
import type {
	HandstageConnectOptions,
	HandstageLocalOptions,
	HandstageSharedOptions,
	LocalBrowserLaunchOptions,
} from "./types/public/options"
import type { LaunchedChrome } from "./types/public/launchedChrome"
import {
	CDPConnection,
	type CDPConnectionLike,
	type CDPTransport,
	type ExternalCDPSession,
	ExternalConnectionAdapter,
} from "./understudy/cdp"
import { V3Context } from "./understudy/context"
import type { Page } from "./understudy/page"

const DEFAULT_VIEWPORT = { width: 1288, height: 711 }

/**
 * V3 (alias `Handstage`)
 *
 * One V3 instance == one CDP connection + one root browser context.
 *
 * Connection lifecycle rules:
 *
 * - V3 owns the connection it constructs (`connectLocal`, `connectTransport`,
 *   `connectSession`) and closes it on `close()`.
 * - V3 does NOT own a connection it attached to via `connectConnection`; the
 *   caller is responsible for closing the shared connection after all
 *   attached V3 instances have been closed.
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

	private constructor(
		connection: CDPConnectionLike,
		cleanup: (() => Promise<void>) | undefined,
		defaultContext: V3Context,
		opts: HandstageSharedOptions,
		instanceId: string,
		logSink: LogSink,
	) {
		this.connection = connection
		this.cleanup = cleanup
		this.defaultContext = defaultContext
		this._contexts.add(this.defaultContext)

		this.logSink = logSink
		this.verbose = opts.verbose ?? LogLevel.Info
		this.instanceId = instanceId
		this.sessionId = opts.sessionId ?? this.instanceId

		this.connection.onTransportClosed(this._onCDPClosed)
	}

	private static setupContext(opts?: HandstageSharedOptions) {
		const instanceId = uuidv7()
		const sharedOpts = opts ?? {}
		const logSink = createFilteredLogger(sharedOpts.logger, sharedOpts.verbose)
		const logger: LogSink = (line) => logSink(line)
		return { instanceId, sharedOpts, logSink, logger }
	}

	static async connectWS(
		ws: WebSocket,
		opts?: HandstageConnectOptions,
	): Promise<V3> {
		const { instanceId, sharedOpts, logSink, logger } = V3.setupContext(opts)

		return await (async () => {
			logger({
				category: "init",
				message: "Connecting via WebSocket",
				level: LogLevel.Info,
			})

			const transport: CDPTransport = {
				send: (message) => ws.send(message),
				close: () => ws.close(),
			}

			ws.addEventListener("message", (event) => {
				if (transport.onmessage) transport.onmessage(event.data.toString())
			})
			ws.addEventListener("close", (event) => {
				if (transport.onclose)
					transport.onclose(`code=${event.code} reason=${event.reason}`)
			})
			ws.addEventListener("error", (event) => {
				if (transport.onerror)
					transport.onerror(new Error("WebSocket error"))
			})

			const conn = new CDPConnection(transport)
			const lbo: LocalBrowserLaunchOptions = opts
				? {
						viewport: opts.viewport,
						deviceScaleFactor: opts.deviceScaleFactor,
						downloadsPath: opts.downloadsPath,
						acceptDownloads: opts.acceptDownloads,
					}
				: {}
			let ctx: V3Context
			try {
				ctx = await V3Context.createFromConnection(conn, {
					localBrowserLaunchOptions: lbo,
					logger: logSink,
				})
			} catch (err) {
				await conn.close().catch(() => {})
				throw err
			}
			let cleanedUp = false
			const cleanup = async () => {
				if (cleanedUp) return
				cleanedUp = true
				await conn.close().catch(() => {})
			}
			const v3 = new V3(
				conn,
				cleanup,
				ctx,
				sharedOpts,
				instanceId,
				logSink,
			)
			await v3._applyPostConnectLocalOptions(lbo)
			return v3
		})()
	}

	static async connectLocal(
		chrome: LaunchedChrome,
		opts?: HandstageLocalOptions,
	): Promise<V3> {
		const { instanceId, sharedOpts, logSink, logger } = V3.setupContext(opts)

		return await (async () => {
			logger({
				category: "init",
				message: "Connecting via LaunchedChrome (pipe)",
				level: LogLevel.Info,
			})

			const reader = chrome.stdout.getReader()
			const writer = chrome.stdin.getWriter()
			const textDecoder = new TextDecoder()
			const textEncoder = new TextEncoder()

			let isClosed = false
			const transport: CDPTransport = {
				send: (message) => {
					if (isClosed) return
					// Write as null-terminated string over pipe
					writer.write(textEncoder.encode(message + "\0")).catch(() => {})
				},
				close: () => {
					if (isClosed) return
					isClosed = true
					writer.close().catch(() => {})
					chrome.close().catch(() => {})
				},
			}

			// Read loop
			void (async () => {
				let buffer = ""
				try {
					while (!isClosed) {
						const { value, done } = await reader.read()
						if (done) break
						buffer += textDecoder.decode(value, { stream: true })
						
						let nullIdx = buffer.indexOf("\0")
						while (nullIdx !== -1) {
							const msg = buffer.slice(0, nullIdx)
							buffer = buffer.slice(nullIdx + 1)
							if (transport.onmessage) {
								transport.onmessage(msg)
							}
							nullIdx = buffer.indexOf("\0")
						}
					}
				} catch (err) {
					if (transport.onerror) {
						transport.onerror(err instanceof Error ? err : new Error(String(err)))
					}
				} finally {
					if (transport.onclose && !isClosed) {
						transport.onclose("Pipe closed")
					}
					isClosed = true
				}
			})()

			const conn = new CDPConnection(transport)
			const lbo: LocalBrowserLaunchOptions = opts?.localBrowserLaunchOptions ?? {}

			let ctx: V3Context
			try {
				ctx = await V3Context.createFromConnection(conn, {
					localBrowserLaunchOptions: lbo,
					logger: logSink,
				})
			} catch (err) {
				await conn.close().catch(() => {})
				await chrome.close().catch(() => {})
				throw err
			}

			let cleanedUp = false
			const cleanup = async () => {
				if (cleanedUp) return
				cleanedUp = true
				await conn.close().catch(() => {})
				await chrome.close().catch(() => {})
			}
			const v3 = new V3(
				conn,
				cleanup,
				ctx,
				sharedOpts,
				instanceId,
				logSink,
			)
			await v3._applyPostConnectLocalOptions(lbo)
			return v3
		})()
	}

	static async connectTransport(
		transport: CDPTransport,
		opts?: HandstageConnectOptions,
	): Promise<V3> {
		const { instanceId, sharedOpts, logSink, logger } = V3.setupContext(opts)

		return await (async () => {
			logger({
				category: "init",
				message: "Connecting via custom transport",
				level: LogLevel.Info,
			})
			const conn = new CDPConnection(transport)
			const lbo: LocalBrowserLaunchOptions = opts
				? {
						viewport: opts.viewport,
						deviceScaleFactor: opts.deviceScaleFactor,
						downloadsPath: opts.downloadsPath,
						acceptDownloads: opts.acceptDownloads,
					}
				: {}
			let ctx: V3Context
			try {
				ctx = await V3Context.createFromConnection(conn, {
					localBrowserLaunchOptions: lbo,
					logger: logSink,
				})
			} catch (err) {
				await conn.close().catch(() => {})
				throw err
			}
			let cleanedUp = false
			const cleanup = async () => {
				if (cleanedUp) return
				cleanedUp = true
				await conn.close().catch(() => {})
			}
			const v3 = new V3(
				conn,
				cleanup,
				ctx,
				sharedOpts,
				instanceId,
				logSink,
			)
			await v3._applyPostConnectLocalOptions(lbo)
			return v3
		})()
	}

	static async connectSession(
		session: ExternalCDPSession,
		opts?: HandstageConnectOptions,
	): Promise<V3> {
		const { instanceId, sharedOpts, logSink, logger } = V3.setupContext(opts)

		return await (async () => {
			logger({
				category: "init",
				message: "Connecting via custom connection",
				level: LogLevel.Info,
			})
			const adapter = new ExternalConnectionAdapter(session)
			const lbo: LocalBrowserLaunchOptions = opts
				? {
						viewport: opts.viewport,
						deviceScaleFactor: opts.deviceScaleFactor,
						downloadsPath: opts.downloadsPath,
						acceptDownloads: opts.acceptDownloads,
					}
				: {}
			let ctx: V3Context
			try {
				ctx = await V3Context.createFromConnection(adapter, {
					localBrowserLaunchOptions: lbo,
					logger: logSink,
				})
			} catch (err) {
				await adapter.close().catch(() => {})
				throw err
			}
			let cleanedUp = false
			const cleanup = async () => {
				if (cleanedUp) return
				cleanedUp = true
				await adapter.close().catch(() => {})
			}
			const v3 = new V3(
				adapter,
				cleanup,
				ctx,
				sharedOpts,
				instanceId,
				logSink,
			)
			await v3._applyPostConnectLocalOptions(lbo)
			return v3
		})()
	}

	/**
	 * Attach a V3 instance to a pre-existing `CDPConnectionLike` that the
	 * caller is managing.  V3 will NOT close the connection on `close()` —
	 * the caller is responsible for the connection's lifetime.
	 *
	 * Use this for advanced sharing scenarios (one CDP connection, many V3
	 * instances).  The `TargetRouter` for the connection is shared automatically.
	 */
	static async connectConnection(
		conn: CDPConnectionLike,
		opts?: HandstageConnectOptions,
	): Promise<V3> {
		const { instanceId, sharedOpts, logSink, logger } = V3.setupContext(opts)

		return await (async () => {
			logger({
				category: "init",
				message: "Attaching to shared CDP connection",
				level: LogLevel.Info,
			})
			const lbo: LocalBrowserLaunchOptions = opts
				? {
						viewport: opts.viewport,
						deviceScaleFactor: opts.deviceScaleFactor,
						downloadsPath: opts.downloadsPath,
						acceptDownloads: opts.acceptDownloads,
					}
				: {}
			const ctx = await V3Context.createFromConnection(conn, {
				localBrowserLaunchOptions: lbo,
				logger: logSink,
			})
			const v3 = new V3(
				conn,
				undefined,
				ctx,
				sharedOpts,
				instanceId,
				logSink,
			)
			await v3._applyPostConnectLocalOptions(lbo)
			return v3
		})()
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

	/** Apply post-connect local browser options that require CDP. */
	private async _applyPostConnectLocalOptions(
		lbo: LocalBrowserLaunchOptions,
	): Promise<void> {
		await this.defaultContext
			.setDownloadBehavior({
				downloadPath: lbo.downloadsPath,
				acceptDownloads: lbo.acceptDownloads,
			})
			.catch(() => {})
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
	 * const handstage = await V3.connectLocal()
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
