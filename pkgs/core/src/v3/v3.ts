import fs from "fs"
import os from "os"
import path from "path"
import process from "process"
import { v7 as uuidv7 } from "uuid"
import { launchLocalChrome } from "./launch/local"
import {
	bindInstanceLogger,
	unbindInstanceLogger,
	withInstanceLogContext,
} from "./logger"
import { cleanupLocalBrowser } from "./shutdown/cleanupLocal"
import { startShutdownSupervisor } from "./shutdown/supervisorClient"
import type { InitState } from "./types/private/internal"
import type {
	ShutdownSupervisorConfig,
	ShutdownSupervisorHandle,
} from "./types/private/shutdown"
import { createConsoleLogger } from "./types/public/consoleLogger"
import {
	type Logger,
	LogLevel,
	type LogLine,
	shouldEmitLogLine,
} from "./types/public/logs"
import type {
	LocalBrowserLaunchOptions,
	HandstagesLocalOptions,
	HandstagesSharedOptions,
} from "./types/public/options"
import { CdpConnection, type CDPTransport, type ExternalCDPSession, ExternalConnectionAdapter } from "./understudy/cdp"
import { V3Context } from "./understudy/context"

const DEFAULT_VIEWPORT = { width: 1288, height: 711 }

/**
 * V3
 *
 * Launches or attaches to local Chrome over CDP and exposes the CDP-backed {@link V3Context}.
 */
export class V3 {
	private _isClosing = false

	private _onCdpClosed = (why: string) => {
		this._immediateShutdown(`CDP transport closed: ${why}`).catch(() => {})
	}

	private readonly logSink: Logger
	public verbose: LogLevel
	private readonly instanceId: string
	private readonly sessionId: string
	private keepAlive?: boolean
	private shutdownSupervisor: ShutdownSupervisorHandle | null = null

	private constructor(
		private state: InitState,
		private ctx: V3Context,
		opts: HandstagesSharedOptions,
		instanceId: string,
		emitLog: (line: LogLine) => void,
		logSink: Logger
	) {
		this.logSink = logSink
		this.verbose = opts.verbose ?? LogLevel.Info
		this.instanceId = instanceId
		this.sessionId = opts.sessionId ?? this.instanceId
		this.keepAlive = opts.keepAlive

		bindInstanceLogger(this.instanceId, (line) => this.emitLog(line))

		this.ctx.conn.onTransportClosed(this._onCdpClosed)
	}

	private static setupLogging(opts: HandstagesSharedOptions, instanceId: string) {
		const verbose = opts.verbose ?? LogLevel.Info
		const logSink = opts.logger ?? createConsoleLogger()
		const emitLog = (line: LogLine) => {
			if (!shouldEmitLogLine(line.level, verbose)) return
			logSink({ ...line, level: line.level ?? LogLevel.Info })
		}
		bindInstanceLogger(instanceId, emitLog)
		return { emitLog, logSink }
	}

	static async connectLocal(opts?: HandstagesLocalOptions): Promise<V3> {
		const instanceId = uuidv7()
		const sharedOpts = opts ?? {}
		const { emitLog, logSink } = this.setupLogging(sharedOpts, instanceId)
		const logger = (line: LogLine) => emitLog(line)

		try {
			return await withInstanceLogContext(instanceId, async () => {
				const envHeadless = process.env.HEADLESS
				if (envHeadless !== undefined) {
					const normalized = envHeadless.trim().toLowerCase()
					if (normalized !== "true") {
						delete process.env.HEADLESS
					}
				}
				const lbo: LocalBrowserLaunchOptions = opts?.localBrowserLaunchOptions ?? {}

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
					const ctx = await V3Context.create(lbo.cdpUrl, {
						cdpHeaders: lbo.cdpHeaders,
					})
					const state: InitState = {
						kind: "LOCAL",
						chrome: {
							kill: async () => {},
						} as unknown as import("chrome-launcher").LaunchedChrome,
						ws: lbo.cdpUrl,
					}
					const v3 = new V3(state, ctx, sharedOpts, instanceId, emitLog, logSink)
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
					const base = path.join(os.tmpdir(), "handstages-v3")
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
				const ctx = await V3Context.create(ws, {
					localBrowserLaunchOptions: lbo,
				})
				const state: InitState = {
					kind: "LOCAL",
					chrome,
					ws,
					userDataDir,
					createdTempProfile: createdTemp,
					preserveUserDataDir: !!lbo.preserveUserDataDir,
				}
				
				const v3 = new V3(state, ctx, sharedOpts, instanceId, emitLog, logSink)

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
			})
		} catch (error) {
			try {
				unbindInstanceLogger(instanceId)
			} catch {}
			throw error
		}
	}

	static async connectTransport(transport: CDPTransport, opts?: HandstagesSharedOptions): Promise<V3> {
		const instanceId = uuidv7()
		const sharedOpts = opts ?? {}
		const { emitLog, logSink } = this.setupLogging(sharedOpts, instanceId)
		const logger = (line: LogLine) => emitLog(line)

		try {
			return await withInstanceLogContext(instanceId, async () => {
				logger({
					category: "init",
					message: "Connecting via custom transport",
					level: LogLevel.Info,
				})
				const conn = new CdpConnection(transport)
				const ctx = await V3Context.createFromConnection(conn)
				const state: InitState = {
					kind: "CUSTOM_TRANSPORT",
					transport,
				}
				return new V3(state, ctx, sharedOpts, instanceId, emitLog, logSink)
			})
		} catch (error) {
			try {
				unbindInstanceLogger(instanceId)
			} catch {}
			throw error
		}
	}

	static async connectSession(session: ExternalCDPSession, opts?: HandstagesSharedOptions): Promise<V3> {
		const instanceId = uuidv7()
		const sharedOpts = opts ?? {}
		const { emitLog, logSink } = this.setupLogging(sharedOpts, instanceId)
		const logger = (line: LogLine) => emitLog(line)

		try {
			return await withInstanceLogContext(instanceId, async () => {
				logger({
					category: "init",
					message: "Connecting via custom connection",
					level: LogLevel.Info,
				})
				const adapter = new ExternalConnectionAdapter(session)
				const ctx = await V3Context.createFromConnection(adapter)
				const state: InitState = {
					kind: "CUSTOM_CONNECTION",
					connection: session,
				}
				return new V3(state, ctx, sharedOpts, instanceId, emitLog, logSink)
			})
		} catch (error) {
			try {
				unbindInstanceLogger(instanceId)
			} catch {}
			throw error
		}
	}

	private emitLog(line: LogLine): void {
		if (!shouldEmitLogLine(line.level, this.verbose)) {
			return
		}
		const normalized: LogLine = {
			...line,
			level: line.level ?? LogLevel.Info,
		}
		this.logSink(normalized)
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
		try {
			if (lbo.downloadsPath || lbo.acceptDownloads !== undefined) {
				const behavior = lbo.acceptDownloads === false ? "deny" : "allow"
				await this.ctx.conn
					.send("Browser.setDownloadBehavior", {
						behavior,
						downloadPath: lbo.downloadsPath,
						eventsEnabled: true,
					})
					.catch(() => {})
			}
		} catch {}
	}

	/** Return the browser-level CDP WebSocket endpoint. Returns empty string for custom transports/connections. */
	connectURL(): string {
		if (this.state.kind === "LOCAL") {
			return this.state.ws
		}
		return ""
	}

	/** Expose the current CDP-backed context. */
	public get context(): V3Context {
		return this.ctx
	}

	/** Best-effort cleanup of context and launched resources. */
	async close(opts?: { force?: boolean }): Promise<void> {
		if (this._isClosing && !opts?.force) return
		this._isClosing = true

		const keepAlive = this.keepAlive === true

		try {
			if (this.ctx.conn && this._onCdpClosed) {
				this.ctx.conn.offTransportClosed?.(this._onCdpClosed)
			}
		} catch {}

		try {
			try {
				await this.ctx.close()
			} catch {}

			if (!keepAlive && this.state.kind === "LOCAL") {
				const localState = this.state
				await cleanupLocalBrowser({
					killChrome: () => localState.chrome.kill(),
					userDataDir: localState.userDataDir,
					createdTempProfile: localState.createdTempProfile,
					preserveUserDataDir: localState.preserveUserDataDir,
				})
			}
		} 		finally {
			this.stopShutdownSupervisor()

			this.state = { kind: "UNINITIALIZED" }
			// @ts-expect-error Reset context for cleanup
			this.ctx = undefined
			this._isClosing = false
			try {
				unbindInstanceLogger(this.instanceId)
			} catch {}
		}
	}

	public get logger(): (logLine: LogLine) => void {
		return (logLine: LogLine) => {
			this.emitLog(logLine)
		}
	}
}
