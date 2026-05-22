import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { v7 as uuidv7 } from "uuid"
import { launchLocalChrome } from "./launch/local"
import { createFilteredLogger, type LogSink } from "./logger"
import { cleanupLocalBrowser } from "./shutdown/cleanupLocal"
import { startShutdownSupervisor } from "./shutdown/supervisorClient"
import type { InitState } from "./types/private/internal"
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
import {
	CDPConnection,
	type CDPConnectionLike,
	type CDPTransport,
	type ExternalCDPSession,
	ExternalConnectionAdapter,
} from "./understudy/cdp"
import { V3Context } from "./understudy/context"

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
	private keepAlive?: boolean
	private shutdownSupervisor: ShutdownSupervisorHandle | null = null
	private connection: CDPConnectionLike | null
	private readonly ownsConnection: boolean

	private constructor(
		private state: InitState,
		connection: CDPConnectionLike,
		ownsConnection: boolean,
		private ctx: V3Context | undefined,
		opts: HandstageSharedOptions,
		instanceId: string,
		logSink: LogSink,
	) {
		this.connection = connection
		this.ownsConnection = ownsConnection
		this.logSink = logSink
		this.verbose = opts.verbose ?? LogLevel.Info
		this.instanceId = instanceId
		this.sessionId = opts.sessionId ?? this.instanceId
		this.keepAlive = opts.keepAlive

		this.connection.onTransportClosed(this._onCDPClosed)
	}

	private static setupContext(opts?: HandstageSharedOptions) {
		const instanceId = uuidv7()
		const sharedOpts = opts ?? {}
		const logSink = createFilteredLogger(sharedOpts.logger, sharedOpts.verbose)
		const logger: LogSink = (line) => logSink(line)
		return { instanceId, sharedOpts, logSink, logger }
	}

	static async connectLocal(opts?: HandstageLocalOptions): Promise<V3> {
		const { instanceId, sharedOpts, logSink, logger } = V3.setupContext(opts)

		return await (async () => {
				const envHeadless = process.env.HEADLESS
				if (envHeadless !== undefined) {
					const normalized = envHeadless.trim().toLowerCase()
					if (normalized !== "true") {
						delete process.env.HEADLESS
					}
				}
				const lbo: LocalBrowserLaunchOptions =
					opts?.localBrowserLaunchOptions ?? {}

				if (lbo.cdpHeaders && !lbo.cdpUrl) {
					logger({
						category: "init",
						message:
							"`cdpHeaders` was provided but `cdpUrl` is not set — cdpHeaders will be ignored. Set `cdpUrl` to connect to an existing browser via CDP.",
						level: LogLevel.Debug,
					})
				}

				if (lbo.cdpUrl) {
					logger({
						category: "init",
						message: "Connecting to local browser",
						level: LogLevel.Info,
					})
					const conn = await CDPConnection.connect(lbo.cdpUrl, {
						headers: lbo.cdpHeaders,
					})
					let ctx: V3Context
					try {
						ctx = await V3Context.createFromConnection(conn, {
							localBrowserLaunchOptions: lbo,
							context: lbo.context,
							logger: logSink,
						})
					} catch (err) {
						await conn.close().catch(() => {})
						throw err
					}
					const state: InitState = {
						kind: "ATTACHED_WS",
						ws: lbo.cdpUrl,
					}
					const v3 = new V3(
						state,
						conn,
						true,
						ctx,
						sharedOpts,
						instanceId,
						logSink,
					)
					await v3._applyPostConnectLocalOptions(lbo)
					return v3
				}

				logger({
					category: "init",
					message: "Launching local browser",
					level: LogLevel.Info,
				})

				let userDataDir = lbo.userDataDir
				let createdTemp = false
				if (!userDataDir) {
					const base = path.join(os.tmpdir(), "handstage-v3")
					fs.mkdirSync(base, { recursive: true })
					userDataDir = fs.mkdtempSync(path.join(base, "profile-"))
					createdTemp = true
				}

				const defaults = [
					"--remote-allow-origins=*",
					"--no-first-run",
					"--no-default-browser-check",
					"--disable-dev-shm-usage",
					"--site-per-process",
				]
				let chromeFlags: string[]
				const ignore = lbo.ignoreDefaultArgs
				if (ignore === true) {
					chromeFlags = []
				} else if (Array.isArray(ignore)) {
					chromeFlags = defaults.filter(
						(f) => !ignore.some((ex) => f.includes(ex)),
					)
				} else {
					chromeFlags = [...defaults]
				}

				if (lbo.devtools) chromeFlags.push("--auto-open-devtools-for-tabs")
				if (lbo.locale) chromeFlags.push(`--lang=${lbo.locale}`)
				if (!lbo.viewport) {
					lbo.viewport = DEFAULT_VIEWPORT
				}
				if (lbo.viewport?.width && lbo.viewport?.height) {
					chromeFlags.push(
						`--window-size=${lbo.viewport.width},${lbo.viewport.height + 87}`,
					)
				}
				if (typeof lbo.deviceScaleFactor === "number") {
					chromeFlags.push(
						`--force-device-scale-factor=${Math.max(0.1, lbo.deviceScaleFactor)}`,
					)
				}
				if (lbo.hasTouch) chromeFlags.push("--touch-events=enabled")
				if (lbo.ignoreHTTPSErrors)
					chromeFlags.push("--ignore-certificate-errors")
				if (lbo.proxy?.server)
					chromeFlags.push(`--proxy-server=${lbo.proxy.server}`)
				if (lbo.proxy?.bypass)
					chromeFlags.push(`--proxy-bypass-list=${lbo.proxy.bypass}`)

				if (Array.isArray(lbo.args)) chromeFlags.push(...lbo.args)

				const keepAlive = sharedOpts.keepAlive === true
				const { ws, chrome } = await launchLocalChrome({
					chromePath: lbo.executablePath,
					chromeFlags,
					port: lbo.port,
					headless: lbo.headless,
					userDataDir,
					connectTimeoutMs: lbo.connectTimeoutMs,
					handleSIGINT: !keepAlive,
				})
				if (keepAlive) {
					try {
						chrome.process?.unref?.()
					} catch {}
				}
				const conn = await CDPConnection.connect(ws)
				let ctx: V3Context
				try {
					ctx = await V3Context.createFromConnection(conn, {
						localBrowserLaunchOptions: lbo,
						context: lbo.context,
						logger: logSink,
					})
				} catch (err) {
					await conn.close().catch(() => {})
					try {
						await chrome.kill()
					} catch {}
					if (createdTemp && !lbo.preserveUserDataDir) {
						try {
							fs.rmSync(userDataDir, { recursive: true, force: true })
						} catch {}
					}
					throw err
				}
				const state: InitState = {
					kind: "LAUNCHED",
					chrome,
					ws,
					userDataDir,
					createdTempProfile: createdTemp,
					preserveUserDataDir: !!lbo.preserveUserDataDir,
				}

				const v3 = new V3(
					state,
					conn,
					true,
					ctx,
					sharedOpts,
					instanceId,
					logSink,
				)

				const chromePid = chrome.process?.pid ?? chrome.pid
				if (!keepAlive && chromePid) {
					v3.startShutdownSupervisor({
						kind: "LOCAL",
						pid: chromePid,
						userDataDir,
						createdTempProfile: createdTemp,
						preserveUserDataDir: !!lbo.preserveUserDataDir,
					})
				}

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
						context: opts?.context,
						logger: logSink,
					})
				} catch (err) {
					await conn.close().catch(() => {})
					throw err
				}
				const state: InitState = { kind: "TRANSPORT" }
				const v3 = new V3(
					state,
					conn,
					true,
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
						context: opts?.context,
						logger: logSink,
					})
				} catch (err) {
					await adapter.close().catch(() => {})
					throw err
				}
				const state: InitState = { kind: "SESSION" }
				const v3 = new V3(
					state,
					adapter,
					true,
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
					context: opts?.context,
					logger: logSink,
				})
				const state: InitState = { kind: "SHARED_CONNECTION" }
				const v3 = new V3(
					state,
					conn,
					false,
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
		if (!this.ctx) return
		await this.ctx
			.setDownloadBehavior({
				downloadPath: lbo.downloadsPath,
				acceptDownloads: lbo.acceptDownloads,
			})
			.catch(() => {})
	}

	/**
	 * Return the browser-level CDP WebSocket endpoint when this V3 owns one.
	 *
	 * Returns `null` for V3 instances created from a custom transport,
	 * custom session, or a shared connection — those do not expose a
	 * stable WebSocket URL.
	 */
	connectURL(): string | null {
		if (this.state.kind === "UNINITIALIZED") {
			throw new Error("Cannot access connectURL: V3 instance is closed")
		}
		if (this.state.kind === "LAUNCHED" || this.state.kind === "ATTACHED_WS") {
			return this.state.ws
		}
		return null
	}

	/** Expose the current CDP-backed (default) browser context. */
	public get context(): V3Context {
		if (!this.ctx) {
			throw new Error("Cannot access context: V3 instance is closed")
		}
		return this.ctx
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
	 * const isolated = await handstage.create({ disposeOnDetach: true })
	 * await isolated.newPage("https://example.com")
	 * await isolated.close()
	 */
	public async create(options?: CreateContextOptions): Promise<V3Context> {
		return this.context.createBrowserContext(options)
	}

	/** Best-effort cleanup of context and launched resources. */
	async close(opts?: { force?: boolean }): Promise<void> {
		if (this._isClosing && !opts?.force) return
		this._isClosing = true

		const keepAlive = this.keepAlive === true

		try {
			if (this.connection && this._onCDPClosed) {
				this.connection.offTransportClosed?.(this._onCDPClosed)
			}
		} catch {}

		try {
			try {
				await this.ctx?.close()
			} catch {}

			if (this.ownsConnection && this.connection) {
				try {
					await this.connection.close()
				} catch {}
			}

			if (!keepAlive && this.state.kind === "LAUNCHED") {
				const launched = this.state
				await cleanupLocalBrowser({
					killChrome: () => launched.chrome.kill(),
					userDataDir: launched.userDataDir,
					createdTempProfile: launched.createdTempProfile,
					preserveUserDataDir: launched.preserveUserDataDir,
				})
			}
		} finally {
			this.stopShutdownSupervisor()

			this.state = { kind: "UNINITIALIZED" }
			this.ctx = undefined
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
