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
	V3Options,
} from "./types/public/options"
import { StagehandNotInitializedError } from "./types/public/sdkErrors"
import { V3Context } from "./understudy/context"

const DEFAULT_VIEWPORT = { width: 1288, height: 711 }

/**
 * V3
 *
 * Launches or attaches to local Chrome over CDP and exposes the CDP-backed {@link V3Context}.
 */
export class V3 {
	private readonly opts: V3Options
	private state: InitState = { kind: "UNINITIALIZED" }
	private ctx: V3Context | null = null

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

	constructor(opts: V3Options) {
		this.opts = { env: "LOCAL", ...opts }
		this.logSink = opts.logger ?? createConsoleLogger()
		this.verbose = opts.verbose ?? LogLevel.Info
		this.instanceId = uuidv7()
		this.sessionId = opts.sessionId ?? this.instanceId
		this.keepAlive = opts.keepAlive

		bindInstanceLogger(this.instanceId, (line: LogLine) => this.emitLog(line))
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

	/**
	 * Initializes the CDP context: launches or attaches to local Chrome.
	 */
	async init(): Promise<void> {
		try {
			return await withInstanceLogContext(this.instanceId, async () => {
				const envHeadless = process.env.HEADLESS
				if (envHeadless !== undefined) {
					const normalized = envHeadless.trim().toLowerCase()
					if (normalized !== "true") {
						delete process.env.HEADLESS
					}
				}
				const lbo: LocalBrowserLaunchOptions =
					this.opts.localBrowserLaunchOptions ?? {}

				if (lbo.cdpHeaders && !lbo.cdpUrl) {
					this.logger({
						category: "init",
						message:
							"`cdpHeaders` was provided but `cdpUrl` is not set — cdpHeaders will be ignored. Set `cdpUrl` to connect to an existing browser via CDP.",
						level: LogLevel.Debug,
					})
				}

				if (lbo.cdpUrl) {
					this.logger({
						category: "init",
						message: "Connecting to local browser",
						level: LogLevel.Info,
					})
					this.ctx = await V3Context.create(lbo.cdpUrl, {
						cdpHeaders: lbo.cdpHeaders,
					})
					this.ctx.conn.onTransportClosed(this._onCdpClosed)
					this.state = {
						kind: "LOCAL",
						chrome: {
							kill: async () => {},
						} as unknown as import("chrome-launcher").LaunchedChrome,
						ws: lbo.cdpUrl,
					}
					await this._applyPostConnectLocalOptions(lbo)
					return
				}
				this.logger({
					category: "init",
					message: "Launching local browser",
					level: LogLevel.Info,
				})

				let userDataDir = lbo.userDataDir
				let createdTemp = false
				if (!userDataDir) {
					const base = path.join(os.tmpdir(), "stagehand-v3")
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

				const keepAlive = this.keepAlive === true
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
				this.ctx = await V3Context.create(ws, {
					localBrowserLaunchOptions: lbo,
				})
				this.ctx.conn.onTransportClosed(this._onCdpClosed)
				this.state = {
					kind: "LOCAL",
					chrome,
					ws,
					userDataDir,
					createdTempProfile: createdTemp,
					preserveUserDataDir: !!lbo.preserveUserDataDir,
				}
				const chromePid = chrome.process?.pid ?? chrome.pid
				if (!keepAlive && chromePid) {
					this.startShutdownSupervisor({
						kind: "LOCAL",
						pid: chromePid,
						userDataDir,
						createdTempProfile: createdTemp,
						preserveUserDataDir: !!lbo.preserveUserDataDir,
					})
				}

				await this._applyPostConnectLocalOptions(lbo)
			})
		} catch (error) {
			try {
				unbindInstanceLogger(this.instanceId)
			} catch {}
			throw error
		}
	}

	/** Apply post-connect local browser options that require CDP. */
	private async _applyPostConnectLocalOptions(
		lbo: LocalBrowserLaunchOptions,
	): Promise<void> {
		try {
			if (lbo.downloadsPath || lbo.acceptDownloads !== undefined) {
				const behavior = lbo.acceptDownloads === false ? "deny" : "allow"
				await this.ctx?.conn
					.send("Browser.setDownloadBehavior", {
						behavior,
						downloadPath: lbo.downloadsPath,
						eventsEnabled: true,
					})
					.catch(() => {})
			}
		} catch {}
	}

	/** Return the browser-level CDP WebSocket endpoint. */
	connectURL(): string {
		if (this.state.kind === "UNINITIALIZED") {
			throw new StagehandNotInitializedError("connectURL()")
		}
		return this.state.ws
	}

	/** Expose the current CDP-backed context (null before {@link init}). */
	public get context(): V3Context | null {
		return this.ctx
	}

	/** Best-effort cleanup of context and launched resources. */
	async close(opts?: { force?: boolean }): Promise<void> {
		if (this._isClosing && !opts?.force) return
		this._isClosing = true

		const keepAlive = this.keepAlive === true

		try {
			if (this.ctx?.conn && this._onCdpClosed) {
				this.ctx.conn.offTransportClosed?.(this._onCdpClosed)
			}
		} catch {}

		try {
			try {
				await this.ctx?.close()
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
		} finally {
			this.stopShutdownSupervisor()

			this.state = { kind: "UNINITIALIZED" }
			this.ctx = null
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
