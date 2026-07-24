import type { Protocol } from "devtools-protocol"
import { defaultLogger, type LogSink } from "../logger"
import type { InitScriptSource } from "../types/private/index"
import type {
	ClearCookieOptions,
	Cookie,
	CookieParam,
	CreateContextOptions,
} from "../types/public/context"
import type { LocalBrowserLaunchOptions } from "../types/public/index"
import { LogLevel } from "../types/public/logs"
import {
	CDPConnectionClosedError,
	HandstageSetExtraHTTPHeadersError,
	PageNotFoundError,
	TimeoutError,
} from "../types/public/sdkErrors"
import {
	type CDPConnectionLike,
	type CDPEvent,
	type CDPEventParams,
	type CDPSessionLike,
	queueCDPCommand,
	sendCDPWithSignal,
	sendCDPWithSignalAndLateResult,
} from "./cdp"
import {
	type DefaultTargetOwner,
	getConnectionResourceManager,
} from "./connectionResourceManager"
import { ContextCookies } from "./contextCookies"
import { executionContexts } from "./executionContextRegistry"
import { normalizeInitScriptSource } from "./initScripts"
import { Page } from "./page"
import { installV3PiercerIntoSession } from "./piercer"
import { errorMessage } from "./protocolError"
import { releaseObjectIds } from "./runtimeObjectUtils"
import {
	getTargetRouter,
	type TargetRouter,
	type TargetRouterDelegate,
} from "./targetRouter"
import { preparePausedTargetSession } from "./targetSessionSetup"

type TargetId = string
type SessionId = string

type TargetType = "page" | "iframe" | string

const CONTEXT_CLEANUP_TIMEOUT_MS = 2000
const CONTEXT_CREATION_TIMEOUT_MS = 30_000

/**
 * Returns true when the target's URL points to a document with a real,
 * pierceable HTML DOM.  We allowlist the small set of schemes that carry
 * web content rather than trying to blacklist every internal browser scheme
 * (chrome://, chrome-extension://, devtools://, brave://, edge://, …).
 */
function hasInjectableDOM(url: string | undefined): boolean {
	if (!url || url === "") {
		return true
	}
	if (
		url === "about:blank" ||
		url === "about:srcdoc" ||
		url.startsWith("about:blank#")
	) {
		return true
	}
	if (url.startsWith("http://") || url.startsWith("https://")) {
		return true
	}
	if (
		url.startsWith("data:") ||
		url.startsWith("blob:") ||
		url.startsWith("file://") ||
		url.startsWith("filesystem:")
	) {
		return true
	}
	return false
}

function isNonWebTarget(info: Protocol.Target.TargetInfo): boolean {
	return (
		(info.type !== "page" && info.type !== "iframe") ||
		!hasInjectableDOM(info.url)
	)
}

function isTopLevelPage(info: Protocol.Target.TargetInfo): boolean {
	return info.type === "page" && info.subtype !== "iframe"
}

function frameTreeContains(
	tree: Protocol.Page.FrameTree,
	frameId: string,
): boolean {
	if (tree.frame.id === frameId) {
		return true
	}
	return (tree.childFrames ?? []).some((child) =>
		frameTreeContains(child, frameId),
	)
}

/**
 * Context
 *
 * Owns the root CDP connection and wires Target/Page events into Page.
 * Maintains one Page per top-level target, adopts OOPIF child sessions into the owner Page,
 * and tracks target→page and (root) frame→target mappings for lookups.
 *
 * IMPORTANT: FrameId → session ownership is managed inside Page (via its FrameRegistry).
 * Context never “guesses” owners; it simply forwards events (with the emitting session)
 * so Page can record the correct owner at event time.
 */
type SessionCleanup = () => void

export class Context implements TargetRouterDelegate {
	/**
	 * Per-instance debug log sink.  Threaded down to Page / NetworkManager /
	 * static helpers so multiple Handstage instances on a shared connection each
	 * receive their own logs without falling back to a global console.
	 */
	public readonly logger: LogSink
	private readonly resources: ReturnType<typeof getConnectionResourceManager>
	private readonly cookieManager: ContextCookies
	private readonly defaultTargetOwner: DefaultTargetOwner = Symbol(
		"context target owner",
	)

	private constructor(
		readonly conn: CDPConnectionLike,
		private readonly localBrowserLaunchOptions: LocalBrowserLaunchOptions | null = null,
		private _browserContextId: string | null,
		public readonly isDefaultContext: boolean = false,
		private readonly ownsBrowserContext: boolean = !isDefaultContext,
		logger?: LogSink,
	) {
		this.logger = logger ?? defaultLogger()
		this.targetRouter = getTargetRouter(this.conn)
		this.resources = getConnectionResourceManager(this.conn)
		this.cookieManager = new ContextCookies(this.conn, () =>
			!this.isDefaultContext ? this.browserContextId : null,
		)
	}

	private readonly targetRouter: TargetRouter
	private routerUnsubscribe: (() => void) | null = null
	private knownNonDefaultBrowserContextIds: Set<string> | null = null
	private nonDefaultContextLookupFailed = false
	private readonly ownedTargetIds = new Set<TargetId>()
	private readonly recentlyDestroyedTargets = new Map<TargetId, number>()

	public get browserContextId(): string | null {
		return this._browserContextId
	}

	private readonly _piercerInstalled = new Set<string>()

	private readonly _sessionInit = new Set<SessionId>()
	private pagesByTarget = new Map<TargetId, Page>()
	private mainFrameToTarget = new Map<string, TargetId>()
	private sessionOwnerPage = new Map<SessionId, Page>()
	private frameOwnerPage = new Map<string, Page>()
	private pendingOopifByMainFrame = new Map<string, SessionId>()
	private createdAtByTarget = new Map<TargetId, number>()
	private typeByTarget = new Map<TargetId, TargetType>()
	private pendingCreatedTargetUrl = new Map<TargetId, string>()
	private readonly initScripts: string[] = []
	private extraHttpHeaders: Record<string, string> | null = null
	private _isClosed = false
	private closePromise: Promise<void> | null = null
	private closeInProgress = false
	private readonly lifetimeController = new AbortController()
	private readonly _onCloseCallbacks = new Set<() => void>()

	public get isClosed(): boolean {
		return this._isClosed
	}

	/**
	 * Register a callback invoked once after this context closes
	 * (immediately if it is already closed).
	 */
	public registerOnCloseCallback(cb: () => void): void {
		if (this._isClosed) {
			cb()
			return
		}
		this._onCloseCallbacks.add(cb)
	}

	private notifyClosed(): void {
		for (const cb of this._onCloseCallbacks) {
			try {
				cb()
			} catch {}
		}
		this._onCloseCallbacks.clear()
	}

	private assertOpen(): void {
		if (this._isClosed) {
			throw new CDPConnectionClosedError("browser context is closed")
		}
	}

	/**
	 * Per-session disposer registry.  Holds every listener (or other
	 * teardown callback) this Context registered against a given child
	 * session, keyed by sessionId.  Drained both when the session detaches
	 * (`onDetachedFromTarget`) and when the context closes — so for
	 * dedicated contexts on a shared connection the connection's
	 * `${sessionId}:Event` handler map doesn't accumulate stale entries
	 * for the connection's lifetime.
	 */
	private readonly _sessionCleanups = new Map<SessionId, SessionCleanup[]>()
	private readonly _wiredFrameSessions = new Set<SessionId>()
	private readonly _consoleDrainHandlers = new Map<
		SessionId,
		(params: Protocol.Runtime.ConsoleAPICalledEvent) => void
	>()

	private _registerSessionCleanup(
		sessionId: SessionId,
		cleanup: SessionCleanup,
	): void {
		if (this._isClosed) {
			cleanup()
			return
		}
		let cleanups = this._sessionCleanups.get(sessionId)
		if (!cleanups) {
			cleanups = []
			this._sessionCleanups.set(sessionId, cleanups)
		}
		cleanups.push(cleanup)
	}

	private _drainSessionCleanups(sessionId: SessionId): void {
		const cleanups = this._sessionCleanups.get(sessionId)
		if (!cleanups) {
			return
		}
		this._sessionCleanups.delete(sessionId)
		this._consoleDrainHandlers.delete(sessionId)
		for (const c of cleanups) {
			try {
				c()
			} catch (err) {
				try {
					this.logger({
						category: "ctx",
						message: "Session cleanup callback threw",
						level: LogLevel.Debug,
						attributes: {
							sessionId,
							error: errorMessage(err),
						},
					})
				} catch {}
			}
		}
	}

	private _stopConsoleDrain(
		sessionId: SessionId,
		session: CDPSessionLike,
	): void {
		const handler = this._consoleDrainHandlers.get(sessionId)
		if (!handler) {
			return
		}
		this._consoleDrainHandlers.delete(sessionId)
		try {
			session.off("Runtime.consoleAPICalled", handler)
		} catch {}
	}

	/**
	 * Register and track a CDP-session-scoped event listener so it can be
	 * removed when the session detaches or the context closes.  This API
	 * is for **child sessions only** — passing the root connection
	 * (which has `id === null`) would silently leak handlers because the
	 * root has no per-session bookkeeping here.  We assert against that
	 * to fail loudly during development.
	 */
	private _addSessionListener<E extends CDPEvent>(
		session: CDPSessionLike,
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const sessionId = session.id
		if (!sessionId) {
			throw new Error(
				"_addSessionListener requires a child CDP session with a non-null id; root-connection listeners must use this.conn.on() and be removed manually.",
			)
		}
		session.on(event, handler)
		this._registerSessionCleanup(sessionId, () => session.off(event, handler))
	}

	/**
	 * Create a Context from an existing CDPConnectionLike.  By default a new
	 * dedicated browser context is created so multiple Handstage instances can
	 * share one browser websocket without sharing pages/storage.
	 *
	 * Context never closes the connection it was handed — connection
	 * lifecycle is the caller's responsibility (Handstage owns it for the
	 * `connectLocal` / `connectTransport` / `connectSession` paths).
	 */
	static async createFromConnection(
		conn: CDPConnectionLike,
		opts?: {
			localBrowserLaunchOptions?: LocalBrowserLaunchOptions | null
			logger?: LogSink
			signal?: AbortSignal
		},
	): Promise<Context> {
		return Context.createDefaultFromConnection(conn, opts)
	}

	static async createDefaultFromConnection(
		conn: CDPConnectionLike,
		opts?: {
			localBrowserLaunchOptions?: LocalBrowserLaunchOptions | null
			logger?: LogSink
			signal?: AbortSignal
		},
	): Promise<Context> {
		const ctx = new Context(
			conn,
			opts?.localBrowserLaunchOptions ?? null,
			null,
			true,
			false,
			opts?.logger,
		)
		const stopForwardingAbort = ctx.forwardAbort(opts?.signal)
		try {
			await ctx.bootstrap()
			return ctx
		} catch (err) {
			try {
				await ctx.close()
			} catch (cleanupError) {
				throw new AggregateError(
					[err, cleanupError],
					"Failed to initialize and close the default browser context",
					{ cause: err },
				)
			}
			throw err
		} finally {
			stopForwardingAbort()
		}
	}

	static async createIsolatedFromConnection(
		conn: CDPConnectionLike,
		opts?: {
			localBrowserLaunchOptions?: LocalBrowserLaunchOptions | null
			createOptions?: CreateContextOptions
			logger?: LogSink
			signal?: AbortSignal
		},
	): Promise<Context> {
		const createOptions: CreateContextOptions = {
			disposeOnDetach: true,
			...opts?.createOptions,
		}
		const creationController = new AbortController()
		const creationTimer = setTimeout(
			() =>
				creationController.abort(
					new TimeoutError(
						"Target.createBrowserContext",
						CONTEXT_CREATION_TIMEOUT_MS,
					),
				),
			CONTEXT_CREATION_TIMEOUT_MS,
		)
		const creationSignal = opts?.signal
			? AbortSignal.any([opts.signal, creationController.signal])
			: creationController.signal
		const resources = getConnectionResourceManager(conn)
		const disposeLateContext = async (
			browserContextId: string,
		): Promise<void> => {
			try {
				await resources.cleanupBrowserContext(browserContextId)
			} catch (error) {
				try {
					opts?.logger?.({
						category: "ctx",
						message: "Late browser context disposal failed",
						level: LogLevel.Debug,
						attributes: {
							browserContextId,
							error: errorMessage(error),
						},
					})
				} catch {}
				throw error
			}
		}

		const creation = sendCDPWithSignalAndLateResult(
			conn,
			"Target.createBrowserContext",
			creationSignal,
			(result) => disposeLateContext(result.browserContextId),
			createOptions,
		)
		let browserContextId: string | undefined
		try {
			;({ browserContextId } = await creation)
			const ctx = new Context(
				conn,
				opts?.localBrowserLaunchOptions ?? null,
				browserContextId,
				false,
				true,
				opts?.logger,
			)
			const stopForwardingAbort = ctx.forwardAbort(creationSignal)
			try {
				await ctx.bootstrap()
				return ctx
			} catch (err) {
				try {
					await ctx.close()
				} catch (cleanupError) {
					if (browserContextId) {
						resources.rememberBrowserContext(browserContextId)
					}
					throw new AggregateError(
						[err, cleanupError],
						`Failed to initialize and dispose browser context ${browserContextId}`,
						{ cause: err },
					)
				}
				throw err
			} finally {
				stopForwardingAbort()
			}
		} finally {
			clearTimeout(creationTimer)
		}
	}

	private forwardAbort(signal?: AbortSignal): () => void {
		if (!signal) {
			return () => {}
		}
		const onAbort = () => {
			if (this.lifetimeController.signal.aborted) {
				return
			}
			this.lifetimeController.abort(
				signal.reason instanceof Error
					? signal.reason
					: new CDPConnectionClosedError("context initialization aborted"),
			)
		}
		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) {
			onAbort()
		}
		return () => signal.removeEventListener("abort", onAbort)
	}

	private async ensurePiercer(session: CDPSessionLike): Promise<boolean> {
		const id = session.id ?? ""
		if (this._piercerInstalled.has(id)) {
			return true
		}

		const installed = await installV3PiercerIntoSession(
			session,
			this.lifetimeController.signal,
		)
		if (installed && !this._isClosed) {
			this._piercerInstalled.add(id)
		}
		return installed
	}

	public async addInitScript<Arg>(
		script: InitScriptSource<Arg>,
		arg?: Arg,
	): Promise<void> {
		this.assertOpen()
		const source = await normalizeInitScriptSource(script, arg)
		this.assertOpen()
		if (this.initScripts.includes(source)) {
			return
		}
		this.initScripts.push(source)
		const pages = this.pages()
		await Promise.all(pages.map((page) => page.registerInitScript(source)))
	}

	public async setExtraHTTPHeaders(
		headers: Record<string, string>,
	): Promise<void> {
		this.assertOpen()
		const nextHeaders = { ...headers }
		this.extraHttpHeaders = nextHeaders

		const sessions: CDPSessionLike[] = []
		for (const sessionId of this._sessionInit) {
			const session = this.conn.getSession(sessionId)
			if (session) {
				sessions.push(session)
			}
		}

		if (!sessions.length) {
			return
		}

		const results = await Promise.allSettled(
			sessions.map(async (session) => {
				await session.send("Network.enable")
				await session.send("Network.setExtraHTTPHeaders", {
					headers: nextHeaders,
				})
			}),
		)

		const failures = results
			.map((result, index) => ({ result, session: sessions[index] }))
			.filter(
				(
					entry,
				): entry is {
					result: PromiseRejectedResult
					session: CDPSessionLike
				} => entry.result.status === "rejected",
			)
			.map((entry) => {
				const sid = entry.session.id ?? "unknown"
				const message = errorMessage(entry.result.reason)
				return `session=${sid} error=${message}`
			})

		if (failures.length) {
			throw new HandstageSetExtraHTTPHeadersError(failures)
		}
	}

	public async setDownloadBehavior(
		options: {
			downloadPath?: string
			acceptDownloads?: boolean
		},
		signal?: AbortSignal,
	): Promise<void> {
		this.assertOpen()
		if (
			options.downloadPath === undefined &&
			options.acceptDownloads === undefined
		) {
			return
		}
		const behavior: Protocol.Browser.SetDownloadBehaviorRequest["behavior"] =
			options.acceptDownloads === false ? "deny" : "allow"
		const params: Protocol.Browser.SetDownloadBehaviorRequest = {
			behavior,
			downloadPath: options.downloadPath,
			eventsEnabled: true,
		}
		if (!this.isDefaultContext && this.browserContextId) {
			params.browserContextId = this.browserContextId
		}
		if (signal) {
			await sendCDPWithSignal(
				this.conn,
				"Browser.setDownloadBehavior",
				signal,
				params,
			)
		} else {
			await this.conn.send("Browser.setDownloadBehavior", params)
		}
	}

	/**
	 * Return top-level `Page`s (oldest → newest). OOPIF targets are not included.
	 */
	pages(): Page[] {
		const rows: Array<{ tid: TargetId; page: Page; created: number }> = []
		for (const [tid, page] of this.pagesByTarget) {
			if (this.typeByTarget.get(tid) === "page") {
				rows.push({ tid, page, created: this.createdAtByTarget.get(tid) ?? 0 })
			}
		}
		rows.sort((a, b) => a.created - b.created)
		return rows.map((r) => r.page)
	}

	/**
	 * Resolve a top-level tab by target id (`pageId` from agent tools / `Page.pageId`).
	 */
	resolvePageByTargetId(pageId: string): Page | undefined {
		return this.pagesByTarget.get(pageId)
	}

	private async applyInitScriptsToPage(
		page: Page,
		opts?: { seedOnly?: boolean },
	): Promise<void> {
		if (opts?.seedOnly) {
			for (const source of this.initScripts) {
				page.seedInitScript(source)
			}
			return
		}
		for (const source of this.initScripts) {
			await page.registerInitScript(source)
		}
	}

	/**
	 * Resolve an owning `Page` by the **top-level main frame id**.
	 * Note: child (OOPIF) roots are intentionally not present in this mapping.
	 */
	resolvePageByMainFrameId(frameId: string): Page | undefined {
		const targetId = this.mainFrameToTarget.get(frameId)
		return targetId ? this.pagesByTarget.get(targetId) : undefined
	}

	/**
	 * Serialize the full frame tree for a given top-level main frame id.
	 */
	async getFullFrameTreeByMainFrameId(
		rootMainFrameId: string,
	): Promise<Protocol.Page.FrameTree> {
		const owner = this.resolvePageByMainFrameId(rootMainFrameId)
		if (!owner) {
			throw new PageNotFoundError(`mainFrameId=${rootMainFrameId}`)
		}
		return owner.asProtocolFrameTree(rootMainFrameId)
	}

	/**
	 * Create a new top-level page (tab) with the given URL and return its Page object.
	 * Waits until the target is attached and registered.
	 */
	public async newPage(url = "about:blank"): Promise<Page> {
		this.assertOpen()
		const targetUrl = String(url ?? "about:blank")
		const timeoutMs = 5000
		const timeoutController = new AbortController()
		const timeoutTimer = setTimeout(
			() =>
				timeoutController.abort(
					new TimeoutError("newPage: target not attached", timeoutMs),
				),
			timeoutMs,
		)
		const signal = AbortSignal.any([
			this.lifetimeController.signal,
			timeoutController.signal,
		])
		// `browserContextId` is only forwarded for dedicated contexts.  Chrome
		// silently routes targets without a `browserContextId` to the default
		// context but explicitly rejects passing the default context's id to
		// some commands ("Failed to find browser context for id ...").
		const createParams: { url: string; browserContextId?: string } = {
			url: "about:blank",
		}
		if (!this.isDefaultContext && this.browserContextId) {
			createParams.browserContextId = this.browserContextId
		}
		let finishDefaultCreation = () => {}
		if (this.isDefaultContext) {
			finishDefaultCreation = this.resources.beginDefaultTargetCreation()
		}
		let targetId: string | undefined
		try {
			const created = await sendCDPWithSignalAndLateResult(
				this.conn,
				"Target.createTarget",
				signal,
				(result) => this.closeLateOwnedTarget(result.targetId),
				createParams,
			)
			targetId = created.targetId
			if (this.isDefaultContext) {
				this.resources.claimDefaultTarget(targetId, this.defaultTargetOwner)
			}
			finishDefaultCreation()
			signal.throwIfAborted()
			if (this.recentlyDestroyedTargets.delete(targetId)) {
				throw new PageNotFoundError(
					`target destroyed during creation (${targetId})`,
				)
			}
			this.ownedTargetIds.add(targetId)
			this.pendingCreatedTargetUrl.set(targetId, "about:blank")
			await sendCDPWithSignal(this.conn, "Target.activateTarget", signal, {
				targetId,
			}).catch((error) => {
				if (signal.aborted) {
					throw error
				}
			})

			while (true) {
				signal.throwIfAborted()
				if (this.recentlyDestroyedTargets.delete(targetId)) {
					throw new PageNotFoundError(
						`target destroyed during creation (${targetId})`,
					)
				}
				const page = this.pagesByTarget.get(targetId)
				if (page) {
					if (targetUrl !== "about:blank") {
						page.seedCurrentUrl(targetUrl)
						page.startInitialNavigation(targetUrl)
					}
					return page
				}
				await new Promise((resolve) => setTimeout(resolve, 25))
			}
		} catch (error) {
			if (targetId) {
				this.pendingCreatedTargetUrl.delete(targetId)
				this.rememberLateTarget(targetId)
				try {
					await this.closeTrackedOwnedTarget(targetId)
				} catch (cleanupError) {
					this.logLateTargetCloseFailure(targetId, cleanupError)
				}
			}
			throw error
		} finally {
			finishDefaultCreation()
			clearTimeout(timeoutTimer)
		}
	}

	/**
	 * Remove listeners before closing pages. Dedicated contexts also release
	 * their browser-side context; connection ownership remains with Handstage.
	 */
	async close(): Promise<void> {
		if (this.closePromise) {
			if (this.closeInProgress || !this.hasPendingBrowserCleanup()) {
				return this.closePromise
			}
			this.closePromise = null
		}
		this._isClosed = true
		if (!this.lifetimeController.signal.aborted) {
			this.lifetimeController.abort(
				new CDPConnectionClosedError("browser context is closed"),
			)
		}
		this.closeInProgress = true
		const operation = (async () => {
			do {
				await this.closeResources()
			} while (this.hasPendingBrowserCleanup())
			this.notifyClosed()
		})()
		this.closePromise = operation
		try {
			await operation
		} catch (error) {
			// Local teardown is idempotent; keep every failed browser cleanup retryable.
			if (this.closePromise === operation) {
				this.closePromise = null
			}
			throw error
		} finally {
			this.closeInProgress = false
			if (this.closePromise === operation && this.hasPendingBrowserCleanup()) {
				this.closePromise = null
			}
		}
	}

	private hasPendingBrowserCleanup(): boolean {
		return (
			this.ownedTargetIds.size > 0 ||
			this.resources.lateTargetCount > 0 ||
			this.resources.lateBrowserContextCount > 0 ||
			(this.ownsBrowserContext && this.browserContextId !== null)
		)
	}

	/** @internal Finalize in-memory resources after the owning connection is gone. */
	forceLocalFinalize(): void {
		this._isClosed = true
		if (!this.lifetimeController.signal.aborted) {
			this.lifetimeController.abort(
				new CDPConnectionClosedError("browser context connection is closed"),
			)
		}
		try {
			this.routerUnsubscribe?.()
		} catch {}
		this.routerUnsubscribe = null

		for (const sessionId of Array.from(this._sessionCleanups.keys())) {
			this._drainSessionCleanups(sessionId)
		}
		for (const page of new Set(this.pagesByTarget.values())) {
			try {
				page.disposeResources()
			} catch {}
		}

		this.pagesByTarget.clear()
		this.mainFrameToTarget.clear()
		this.sessionOwnerPage.clear()
		this.frameOwnerPage.clear()
		this.pendingOopifByMainFrame.clear()
		this.createdAtByTarget.clear()
		this.typeByTarget.clear()
		this.pendingCreatedTargetUrl.clear()
		for (const targetId of this.ownedTargetIds) {
			this.resources.rememberTarget(targetId)
		}
		this.ownedTargetIds.clear()
		this.resources.releaseDefaultTargets(this.defaultTargetOwner)
		this.recentlyDestroyedTargets.clear()
		this._sessionInit.clear()
		this._piercerInstalled.clear()
		this._wiredFrameSessions.clear()
		this._consoleDrainHandlers.clear()
		this.knownNonDefaultBrowserContextIds = null
		this.nonDefaultContextLookupFailed = false
		this.initScripts.length = 0
		this.extraHttpHeaders = null
		this._browserContextId = null
		this.closePromise = Promise.resolve()
		this.notifyClosed()
	}

	private rememberLateTarget(targetId: TargetId): void {
		this.ownedTargetIds.delete(targetId)
		this.resources.rememberTarget(targetId)
	}

	private logLateTargetCloseFailure(targetId: TargetId, error: unknown): void {
		try {
			this.logger({
				category: "ctx",
				message: "Late target close failed",
				level: LogLevel.Debug,
				attributes: {
					targetId,
					error: errorMessage(error),
				},
			})
		} catch {}
	}

	private closeTrackedOwnedTarget(targetId: TargetId): Promise<void> {
		return this.resources.cleanupTarget(targetId).then(() => {
			this.ownedTargetIds.delete(targetId)
			this.resources.releaseDefaultTarget(targetId, this.defaultTargetOwner)
		})
	}

	private async closeLateOwnedTarget(targetId: TargetId): Promise<void> {
		this.rememberLateTarget(targetId)
		try {
			await this.closeTrackedOwnedTarget(targetId)
		} catch (error) {
			this.logLateTargetCloseFailure(targetId, error)
			throw error
		}
	}

	private async closeResources(): Promise<void> {
		const retryableLateTargets = this.resources
			.lateTargetIds()
			.filter((targetId) => !this.ownedTargetIds.has(targetId))
		const retryableLateBrowserContexts = this.resources
			.lateBrowserContextIds()
			.filter((browserContextId) => browserContextId !== this.browserContextId)
		const initializedSessions = [...this._sessionInit]
		await Promise.all(initializedSessions.map((id) => this.resumeAndDetach(id)))
		this.routerUnsubscribe?.()
		this.routerUnsubscribe = null

		// Drain every per-session cleanup that wasn't already run by an
		// earlier `Target.detachedFromTarget` event.  Iterating a snapshot
		// of the keys avoids invalidating the iterator inside
		// `_drainSessionCleanups()`.
		for (const sessionId of Array.from(this._sessionCleanups.keys())) {
			this._drainSessionCleanups(sessionId)
		}

		const pagesSnapshot = this.pages()
		const pageCloseErrors: unknown[] = []
		if (this.isDefaultContext) {
			const results = await Promise.allSettled(
				pagesSnapshot.map(async (p) => {
					if (!this.ownedTargetIds.has(p.targetId())) {
						this.cleanupByTarget(p.targetId())
						return
					}
					await p.close()
				}),
			)
			for (const result of results) {
				if (result.status === "rejected") {
					pageCloseErrors.push(result.reason)
				}
			}

			const registeredTargets = new Set(
				pagesSnapshot.map((page) => page.targetId()),
			)
			const unattachedTargets = [...this.ownedTargetIds].filter(
				(targetId) => !registeredTargets.has(targetId),
			)
			const unattachedResults = await Promise.allSettled(
				unattachedTargets.map((targetId) =>
					this.closeTrackedOwnedTarget(targetId),
				),
			)
			for (const result of unattachedResults) {
				if (result.status === "rejected") {
					pageCloseErrors.push(result.reason)
				}
			}
		} else {
			await Promise.allSettled(
				pagesSnapshot.map((p) => Promise.resolve(p.disposeResources())),
			)
		}
		const registeredTargets = new Set(
			pagesSnapshot.map((page) => page.targetId()),
		)
		const lateTargets = retryableLateTargets.filter(
			(targetId) => !registeredTargets.has(targetId),
		)
		const lateTargetResults = await Promise.allSettled(
			lateTargets.map((targetId) => this.closeTrackedOwnedTarget(targetId)),
		)
		for (const result of lateTargetResults) {
			if (result.status === "rejected") {
				pageCloseErrors.push(result.reason)
			}
		}

		// Dedicated contexts release their browser-side storage explicitly
		// so subsequent connections don't see stale cookies/local-storage.
		// Default contexts are shared with other actors on the same browser,
		// so we never call Target.disposeBrowserContext for them.
		//
		// We NEVER close the underlying CDP connection here — that is Handstage's
		// responsibility (or the caller's for shared connections).
		const browserDisposeErrors: unknown[] = []
		const ownedTargetsBeforeBrowserDispose = new Set(this.ownedTargetIds)
		if (this.ownsBrowserContext && this.browserContextId) {
			const browserContextId = this.browserContextId
			try {
				await this.resources.cleanupBrowserContext(browserContextId)
				this._browserContextId = null
				for (const targetId of ownedTargetsBeforeBrowserDispose) {
					this.ownedTargetIds.delete(targetId)
					this.resources.forgetTarget(targetId)
				}
			} catch (err) {
				browserDisposeErrors.push(err)
				try {
					this.logger({
						category: "ctx",
						message: "Target.disposeBrowserContext failed during close",
						level: LogLevel.Debug,
						attributes: {
							browserContextId,
							error: errorMessage(err),
						},
					})
				} catch {}
			}
		}

		const lateBrowserContextResults = await Promise.allSettled(
			retryableLateBrowserContexts.map((browserContextId) =>
				this.resources.cleanupBrowserContext(browserContextId),
			),
		)
		for (const result of lateBrowserContextResults) {
			if (result.status === "rejected") {
				browserDisposeErrors.push(result.reason)
			}
		}

		if (pageCloseErrors.length === 0) {
			this.pagesByTarget.clear()
			this.mainFrameToTarget.clear()
			this.sessionOwnerPage.clear()
			this.frameOwnerPage.clear()
			this.pendingOopifByMainFrame.clear()
			this.createdAtByTarget.clear()
			this.typeByTarget.clear()
			this.pendingCreatedTargetUrl.clear()
			this.recentlyDestroyedTargets.clear()
		}

		this._sessionInit.clear()
		this._piercerInstalled.clear()
		this._wiredFrameSessions.clear()
		this.initScripts.length = 0
		this.extraHttpHeaders = null

		const closeErrors = [...pageCloseErrors]
		closeErrors.push(...browserDisposeErrors)
		if (closeErrors.length === 1) {
			throw closeErrors[0]
		}
		if (closeErrors.length > 1) {
			throw new AggregateError(closeErrors, "Failed to close browser context")
		}
	}

	public async canClaimTarget(
		info: Protocol.Target.TargetInfo,
	): Promise<boolean> {
		if (this._isClosed) {
			return false
		}
		if (!this.isDefaultContext) {
			return (
				!!this.browserContextId &&
				info.browserContextId === this.browserContextId
			)
		}
		let explicitOwner: DefaultTargetOwner | undefined
		try {
			explicitOwner = await this.resources.waitForDefaultTargetOwner(
				info.targetId,
				this.lifetimeController.signal,
			)
		} catch (error) {
			if (this._isClosed) {
				return false
			}
			throw error
		}
		if (explicitOwner) {
			return explicitOwner === this.defaultTargetOwner
		}

		const targetContextId = info.browserContextId
		if (!targetContextId) {
			return true
		}
		if (this.browserContextId && targetContextId === this.browserContextId) {
			return true
		}

		// Fast path cache check
		if (this.knownNonDefaultBrowserContextIds?.has(targetContextId)) {
			return false
		}

		// For default context routing, if the target has an explicit browserContextId
		// that we haven't seen, we must verify if it's a known non-default context
		// before claiming it. If we can't fetch contexts, we fall back to learning.
		let nonDefaultIds = await this.getNonDefaultBrowserContextIds()
		if (this._isClosed) {
			return false
		}
		if (nonDefaultIds?.has(targetContextId)) {
			return false
		}
		if (nonDefaultIds) {
			// Cache miss - maybe it's a newly created context? Refresh and check again.
			nonDefaultIds = await this.refreshNonDefaultBrowserContextIds()
			if (this._isClosed) {
				return false
			}
			if (nonDefaultIds?.has(targetContextId)) {
				return false
			}
		}

		if (!this.browserContextId) {
			this._browserContextId = targetContextId
			return true
		}

		return targetContextId === this.browserContextId
	}

	public async onRouterAttachedToTarget(
		info: Protocol.Target.TargetInfo,
		sessionId: SessionId,
	): Promise<void> {
		await this.onAttachedToTarget(info, sessionId)
	}

	public onRouterDetachedFromTarget(
		sessionId: SessionId,
		targetId: string | null,
	): void {
		if (this._isClosed) {
			return
		}
		this.onDetachedFromTarget(sessionId, targetId)
	}

	public onRouterTargetDestroyed(targetId: string): void {
		if (this._isClosed) {
			return
		}
		this.recentlyDestroyedTargets.delete(targetId)
		this.recentlyDestroyedTargets.set(targetId, Date.now())
		while (this.recentlyDestroyedTargets.size > 256) {
			const oldest = this.recentlyDestroyedTargets.keys().next()
			if (oldest.done) {
				break
			}
			this.recentlyDestroyedTargets.delete(oldest.value)
		}
		this.cleanupByTarget(targetId, true)
	}

	private async dispatchResume(
		sessionId: SessionId,
		signal: AbortSignal,
	): Promise<void> {
		const session = this.conn.getSession(sessionId)
		if (!session) {
			return
		}
		try {
			const queued = queueCDPCommand(
				this.conn,
				session,
				"Runtime.runIfWaitingForDebugger",
				signal,
			)
			void queued.response.catch(() => {})
			await queued.dispatched
		} catch {}
	}

	private async resumeAndDetach(sessionId: SessionId): Promise<void> {
		const controller = new AbortController()
		const timer = setTimeout(
			() =>
				controller.abort(
					new TimeoutError(
						"Target.detachFromTarget",
						CONTEXT_CLEANUP_TIMEOUT_MS,
					),
				),
			CONTEXT_CLEANUP_TIMEOUT_MS,
		)
		try {
			await this.dispatchResume(sessionId, controller.signal)
			await sendCDPWithSignal(
				this.conn,
				"Target.detachFromTarget",
				controller.signal,
				{ sessionId },
			)
		} catch {
		} finally {
			clearTimeout(timer)
		}
	}

	private async abortTargetSetup(
		sessionId: SessionId,
		message: string,
	): Promise<never> {
		this._drainSessionCleanups(sessionId)
		this._sessionInit.delete(sessionId)
		this._piercerInstalled.delete(sessionId)
		this._wiredFrameSessions.delete(sessionId)
		for (const [frameId, pendingSessionId] of this.pendingOopifByMainFrame) {
			if (pendingSessionId === sessionId) {
				this.pendingOopifByMainFrame.delete(frameId)
			}
		}
		throw new Error(message)
	}

	private isCurrentSession(
		sessionId: SessionId,
		session: CDPSessionLike,
	): boolean {
		return (
			!this._isClosed &&
			this._sessionInit.has(sessionId) &&
			this.conn.getSession(sessionId) === session
		)
	}

	private async getNonDefaultBrowserContextIds(): Promise<Set<string> | null> {
		if (this.knownNonDefaultBrowserContextIds) {
			return this.knownNonDefaultBrowserContextIds
		}
		if (this.nonDefaultContextLookupFailed) {
			return null
		}

		try {
			const res = await sendCDPWithSignal(
				this.conn,
				"Target.getBrowserContexts",
				this.lifetimeController.signal,
			)
			this.knownNonDefaultBrowserContextIds = new Set(
				res.browserContextIds ?? [],
			)
			return this.knownNonDefaultBrowserContextIds
		} catch (err) {
			if (this.lifetimeController.signal.aborted) {
				throw err
			}
			this.nonDefaultContextLookupFailed = true
			this.logger({
				category: "ctx",
				message:
					"Target.getBrowserContexts not available — default-context target matching will learn the first observed context id",
				level: LogLevel.Debug,
				attributes: { error: errorMessage(err) },
			})
			return null
		}
	}

	private async refreshNonDefaultBrowserContextIds(): Promise<Set<string> | null> {
		this.knownNonDefaultBrowserContextIds = null
		this.nonDefaultContextLookupFailed = false
		return this.getNonDefaultBrowserContextIds()
	}

	/**
	 * Bootstrap target lifecycle:
	 * - Attach to existing targets.
	 * - Handle auto-attach events.
	 * - Clean up on detach/destroy.
	 */
	private async bootstrap(): Promise<void> {
		const signal = this.lifetimeController.signal
		this.routerUnsubscribe = await this.targetRouter.register(
			this,
			this.logger,
			signal,
		)

		const targets = await this.conn.getTargets(signal)
		for (const t of targets) {
			if (!(await this.canClaimTarget(t))) {
				continue
			}
			if (t.attached) {
				continue // Auto-attach already handled this target.
			}
			try {
				await this.conn.attachToTarget(t.targetId, signal)
			} catch (err) {
				signal.throwIfAborted()
				this.logger({
					category: "ctx",
					message: "Failed to attach to existing target during bootstrap",
					level: LogLevel.Debug,
					attributes: {
						targetId: t.targetId,
						targetType: t.type,
						error: errorMessage(err),
					},
				})
			}
		}
		signal.throwIfAborted()
	}

	/**
	 * Handle a newly attached target (top-level or potential OOPIF):
	 * - Enable Page domain and lifecycle events.
	 * - If top-level → create Page, wire listeners, resume.
	 * - Else → probe child root frame id via `Page.getFrameTree` and adopt immediately
	 *   if the parent is known; otherwise stage until parent `frameAttached`.
	 * - Resume the target only after listeners are wired.
	 *
	 * Browser-context isolation: this method is a single chokepoint for
	 * **both** the root `Target.attachedToTarget` listener AND per-session
	 * child-attach listeners.  Filtering on `browserContextId` here is what
	 * keeps multiple `Context` instances sharing one connection from
	 * cross-talking (otherwise both would manage every target).
	 */
	private async onAttachedToTarget(
		info: Protocol.Target.TargetInfo,
		sessionId: SessionId,
	): Promise<void> {
		if (this._isClosed) {
			throw new CDPConnectionClosedError("browser context is closed")
		}

		// TargetRouter should only call us for owned targets.  Keep a defensive
		// ownership check here so direct/internal calls do not accidentally
		// mutate this context for a sibling browser context.
		if (!(await this.canClaimTarget(info))) {
			throw new Error(`Context no longer owns target ${info.targetId}`)
		}
		if (this._isClosed) {
			throw new CDPConnectionClosedError("browser context is closed")
		}

		// Skip non-web targets (workers, chrome extensions, background pages, etc.).
		// They still need to be resumed so we don't leave them paused by
		// waitForDebuggerOnStart, but injecting the piercer into these targets
		// can throw or corrupt their internal state (e.g. Chrome's PDF viewer).
		if (isNonWebTarget(info)) {
			throw new Error(
				`Unsupported target ${info.targetId} with type=${info.type}`,
			)
		}

		const session = this.conn.getSession(sessionId)
		if (!session) {
			throw new Error(`Attached target session ${sessionId} is unavailable`)
		}

		// Init guard
		if (this._sessionInit.has(sessionId)) {
			return
		}
		this._sessionInit.add(sessionId)

		// Register for Runtime events before enabling it so we don't miss
		// initial contexts.  The disposer is tracked so we remove the
		// underlying `Runtime.*` handler registrations from the connection
		// when this session detaches or this Context closes.
		const detachExec = executionContexts.attachSession(session)
		this._registerSessionCleanup(sessionId, detachExec)
		const consoleDrain = (event: Protocol.Runtime.ConsoleAPICalledEvent) => {
			void releaseObjectIds(
				session,
				event.args?.map((arg) => arg.objectId) ?? [],
			)
		}
		this._consoleDrainHandlers.set(sessionId, consoleDrain)
		this._addSessionListener(session, "Runtime.consoleAPICalled", consoleDrain)
		this._addSessionListener(session, "Runtime.exceptionThrown", (event) => {
			void releaseObjectIds(session, [
				event.exceptionDetails.exception?.objectId,
			])
		})

		// Ensure we only resume once even if multiple code paths hit finally.
		let resumed = false
		const resume = async (): Promise<void> => {
			if (resumed) {
				return
			}
			resumed = true
			// waitForDebuggerOnStart pauses new targets; resume once we've done
			// any "must happen before first document" work.
			await this.dispatchResume(sessionId, this.lifetimeController.signal)
		}

		const setup = await preparePausedTargetSession({
			connection: this.conn,
			session,
			signal: this.lifetimeController.signal,
			initScripts: this.initScripts,
			extraHttpHeaders: this.extraHttpHeaders,
		})
		if (!this.isCurrentSession(sessionId, session)) {
			return
		}
		if (!setup.success) {
			// Short-lived child targets can detach before resume is acknowledged.
			// Keep this noisy only for top-level pages where missing attach is fatal.
			if (isTopLevelPage(info)) {
				this.logger({
					category: "ctx",
					message: "Failed target pre-resume setup ordering",
					level: LogLevel.Debug,
					attributes: {
						targetId: info.targetId,
						targetType: info.type,
						...setup.diagnostics,
					},
				})
			}
			return await this.abortTargetSetup(
				sessionId,
				`Target pre-resume setup failed for ${info.targetId}`,
			)
		}
		resumed = true
		const { scriptsInstalled, piercerPreRegistered } = setup

		try {
			// Best-effort lifecycle events; do not block top-level page registration
			// on this optional signal stream.
			void session
				.send("Page.setLifecycleEventsEnabled", { enabled: true })
				.catch(() => {})

			if (isTopLevelPage(info)) {
				await this.registerTopLevelPage(
					info,
					sessionId,
					session,
					scriptsInstalled,
					piercerPreRegistered,
				)
				return
			}
			await this.registerChildTarget(info, sessionId, session)
		} finally {
			await resume()
		}
	}

	private async registerTopLevelPage(
		info: Protocol.Target.TargetInfo,
		sessionId: SessionId,
		session: CDPSessionLike,
		scriptsInstalled: boolean,
		piercerPreRegistered: boolean,
	): Promise<void> {
		let page: Page | null = null
		let createError: unknown
		try {
			page = await Page.create(
				this.conn,
				session,
				info.targetId,
				this.localBrowserLaunchOptions,
				this.logger,
				this.lifetimeController.signal,
			)
		} catch (error) {
			createError = error
		}

		if (!this.isCurrentSession(sessionId, session)) {
			page?.disposeResources()
			return
		}
		if (!page) {
			this.logger({
				category: "ctx",
				message: "Failed to create top-level Page",
				level: LogLevel.Debug,
				attributes: {
					targetId: info.targetId,
					targetType: info.type,
					targetUrl: info.url ?? "",
					error: errorMessage(createError),
				},
			})
			return await this.abortTargetSetup(
				sessionId,
				`Failed to create top-level Page for ${info.targetId}`,
			)
		}

		this.wireSessionToOwnerPage(sessionId, page)
		this._stopConsoleDrain(sessionId, session)
		this.pagesByTarget.set(info.targetId, page)
		page.registerOnCloseCallback(() => {
			this.cleanupByTarget(info.targetId, true)
		})
		this.mainFrameToTarget.set(page.mainFrameId(), info.targetId)
		this.frameOwnerPage.set(page.mainFrameId(), page)
		this.typeByTarget.set(info.targetId, "page")
		if (!this.createdAtByTarget.has(info.targetId)) {
			this.createdAtByTarget.set(info.targetId, Date.now())
		}
		const pendingSeedUrl = this.pendingCreatedTargetUrl.get(info.targetId)
		this.pendingCreatedTargetUrl.delete(info.targetId)
		page.seedCurrentUrl(pendingSeedUrl ?? info.url ?? "")
		this.installFrameEventBridges(sessionId, page)
		if (piercerPreRegistered) {
			this._piercerInstalled.add(sessionId)
		}
		await this.applyInitScriptsToPage(page, { seedOnly: scriptsInstalled })
		if (!piercerPreRegistered) {
			void this.ensurePiercer(session).catch(() => {})
		}
	}

	private async registerChildTarget(
		info: Protocol.Target.TargetInfo,
		sessionId: SessionId,
		session: CDPSessionLike,
	): Promise<void> {
		const piercerReady = await this.ensurePiercer(session).catch(() => false)
		if (!this.isCurrentSession(sessionId, session)) {
			return
		}
		if (!piercerReady) {
			return await this.abortTargetSetup(
				sessionId,
				`Failed to initialize child target ${info.targetId}`,
			)
		}

		try {
			const { frameTree } = await sendCDPWithSignal(
				session,
				"Page.getFrameTree",
				this.lifetimeController.signal,
			)
			if (!this.isCurrentSession(sessionId, session)) {
				return
			}
			const childMainId = frameTree.frame.id
			let owner = this.frameOwnerPage.get(childMainId)
			if (!owner) {
				owner = [...this.pagesByTarget.values()].find((page) =>
					frameTreeContains(
						page.asProtocolFrameTree(page.mainFrameId()),
						childMainId,
					),
				)
			}

			if (!owner) {
				this.pendingOopifByMainFrame.set(childMainId, sessionId)
				return
			}
			owner.adoptOopifSession(session, childMainId)
			this._stopConsoleDrain(sessionId, session)
			this.sessionOwnerPage.set(sessionId, owner)
			this.installFrameEventBridges(sessionId, owner)
			void executionContexts
				.waitForMainWorld(session, childMainId)
				.catch(() => {})
		} catch (error) {
			if (!this.isCurrentSession(sessionId, session)) {
				return
			}
			this.logger({
				category: "ctx",
				message: "OOPIF Page.getFrameTree failed during attach",
				level: LogLevel.Debug,
				attributes: {
					targetId: info.targetId,
					error: errorMessage(error),
				},
			})
			return await this.abortTargetSetup(
				sessionId,
				`Failed to inspect child target ${info.targetId}`,
			)
		}
	}

	/**
	 * Detach handler:
	 * - Remove child session ownership and prune its subtree.
	 * - If a top-level target, cleanup its `Page` and mappings.
	 * - Drop any staged child for this session.
	 */
	private onDetachedFromTarget(
		sessionId: SessionId,
		targetId: string | null,
	): void {
		const owner = this.sessionOwnerPage.get(sessionId)
		if (owner) {
			this.clearFrameOwnership(owner.detachOopifSession(sessionId))
			this.sessionOwnerPage.delete(sessionId)
		}

		if (targetId && this.pagesByTarget.has(targetId)) {
			this.cleanupByTarget(targetId)
		}

		for (const [fid, sid] of Array.from(
			this.pendingOopifByMainFrame.entries(),
		)) {
			if (sid === sessionId) {
				this.pendingOopifByMainFrame.delete(fid)
			}
		}

		// Run the per-session disposers (event-listener removals from
		// `_addSessionListener` and the executionContexts attach handle).
		// This bounds the leak in the connection's per-session
		// `eventHandlers` map by the lifetime of each session, not the
		// lifetime of the Context.
		this._drainSessionCleanups(sessionId)

		this._sessionInit.delete(sessionId)
		this._piercerInstalled.delete(sessionId)
	}

	private clearFrameOwnership(frameIds: Iterable<string>): void {
		for (const frameId of frameIds) {
			this.frameOwnerPage.delete(frameId)
			const pendingSessionId = this.pendingOopifByMainFrame.get(frameId)
			if (!pendingSessionId) {
				continue
			}
			this.pendingOopifByMainFrame.delete(frameId)
			void this.resumeAndDetach(pendingSessionId)
		}
	}

	/**
	 * Cleanup a top-level Page by target id, removing its root and staged children.
	 */
	private cleanupByTarget(targetId: TargetId, releaseOwnership = false): void {
		const page = this.pagesByTarget.get(targetId)
		this.pagesByTarget.delete(targetId)
		this.createdAtByTarget.delete(targetId)
		this.typeByTarget.delete(targetId)
		this.pendingCreatedTargetUrl.delete(targetId)
		this.ownedTargetIds.delete(targetId)
		if (releaseOwnership) {
			this.resources.releaseDefaultTarget(targetId, this.defaultTargetOwner)
		}
		for (const [frameId, mappedTargetId] of this.mainFrameToTarget) {
			if (mappedTargetId === targetId) {
				this.mainFrameToTarget.delete(frameId)
			}
		}
		if (!page) {
			return
		}
		const pageFrameIds = new Set(page.listAllFrameIds())
		for (const [frameId, owner] of this.frameOwnerPage) {
			if (owner === page) {
				pageFrameIds.add(frameId)
			}
		}

		for (const [fid, p] of Array.from(this.frameOwnerPage.entries())) {
			if (p === page) {
				this.frameOwnerPage.delete(fid)
			}
		}

		const pageSessionIds: string[] = []
		for (const [sid, p] of Array.from(this.sessionOwnerPage.entries())) {
			if (p !== page) {
				continue
			}
			pageSessionIds.push(sid)
			this.sessionOwnerPage.delete(sid)
		}
		for (const sessionId of pageSessionIds) {
			this._drainSessionCleanups(sessionId)
			this._sessionInit.delete(sessionId)
			this._piercerInstalled.delete(sessionId)
			this._wiredFrameSessions.delete(sessionId)
		}

		for (const [fid, sessionId] of this.pendingOopifByMainFrame) {
			if (!pageFrameIds.has(fid)) {
				continue
			}
			this.pendingOopifByMainFrame.delete(fid)
			void this.resumeAndDetach(sessionId)
		}

		page.disposeResources()
	}

	/**
	 * Wire Page-domain frame events for a session into the owning Page & mappings.
	 * We forward the *emitting session* with every event so Page can stamp ownership precisely.
	 */
	private installFrameEventBridges(sessionId: SessionId, owner: Page): void {
		if (this._isClosed) {
			return
		}
		const session = this.conn.getSession(sessionId)
		if (!session) {
			return
		}
		if (this._wiredFrameSessions.has(sessionId)) {
			return
		}
		this._wiredFrameSessions.add(sessionId)
		this._registerSessionCleanup(sessionId, () => {
			this._wiredFrameSessions.delete(sessionId)
		})
		const isCurrent = () =>
			!this._isClosed &&
			!owner.isDisposed() &&
			this._wiredFrameSessions.has(sessionId) &&
			this.conn.getSession(sessionId) === session &&
			this.sessionOwnerPage.get(sessionId) === owner

		this._addSessionListener(session, "Page.frameAttached", (evt) => {
			if (!isCurrent()) {
				return
			}
			const { frameId, parentFrameId } = evt
			const previousRoot = owner.mainFrameId()
			owner.onFrameAttached(frameId, parentFrameId ?? null, session)

			// If we were waiting for this id (OOPIF child), adopt now.
			const pendingChildSessionId = this.pendingOopifByMainFrame.get(frameId)
			if (pendingChildSessionId) {
				const child = this.conn.getSession(pendingChildSessionId)
				if (child) {
					owner.adoptOopifSession(child, frameId)
					this._stopConsoleDrain(pendingChildSessionId, child)
					this.sessionOwnerPage.set(child.id ?? "child", owner)
					// Wire bridges for the child so its Page events keep flowing.
					this.installFrameEventBridges(pendingChildSessionId, owner)
				}
				this.pendingOopifByMainFrame.delete(frameId)
			}

			// Track Page ownership for quick reverse lookups (debug helpers).
			this.frameOwnerPage.set(frameId, owner)

			// Root handoff: keep mainFrameToTarget aligned for the page
			if (!parentFrameId) {
				const newRoot = owner.mainFrameId()
				const topTargetId = this.findTargetIdByPage(owner)
				if (topTargetId) {
					if (
						previousRoot !== newRoot &&
						this.mainFrameToTarget.get(previousRoot) === topTargetId
					) {
						this.mainFrameToTarget.delete(previousRoot)
					}
					if (previousRoot !== newRoot) {
						this.frameOwnerPage.delete(previousRoot)
					}
					this.mainFrameToTarget.set(newRoot, topTargetId)
				}
				this.frameOwnerPage.set(newRoot, owner)
			}
		})

		this._addSessionListener(session, "Page.frameDetached", (evt) => {
			if (!isCurrent()) {
				return
			}
			this.clearFrameOwnership(
				owner.onFrameDetached(evt.frameId, evt.reason ?? "remove"),
			)
		})

		this._addSessionListener(session, "Page.frameNavigated", (evt) => {
			if (!isCurrent()) {
				return
			}
			const previousRoot = owner.mainFrameId()
			owner.onFrameNavigated(evt.frame, session)
			const newRoot = owner.mainFrameId()
			if (newRoot === previousRoot) {
				return
			}
			const topTargetId = this.findTargetIdByPage(owner)
			if (!topTargetId) {
				return
			}
			if (this.mainFrameToTarget.get(previousRoot) === topTargetId) {
				this.mainFrameToTarget.delete(previousRoot)
			}
			this.frameOwnerPage.delete(previousRoot)
			this.mainFrameToTarget.set(newRoot, topTargetId)
			this.frameOwnerPage.set(newRoot, owner)
		})

		this._addSessionListener(session, "Page.navigatedWithinDocument", (evt) => {
			if (!isCurrent()) {
				return
			}
			owner.onNavigatedWithinDocument(evt.frameId, evt.url, session)
		})
	}

	/**
	 * Register that a session belongs to a Page (used by event routing).
	 */
	private wireSessionToOwnerPage(sessionId: SessionId, owner: Page): void {
		this.sessionOwnerPage.set(sessionId, owner)
	}

	/**
	 * Utility: reverse-lookup the top-level target id that owns a given Page.
	 */
	private findTargetIdByPage(page: Page): TargetId | undefined {
		for (const [tid, p] of this.pagesByTarget) {
			if (p === page) {
				return tid
			}
		}
		return undefined
	}

	/**
	 * Get all browser cookies, optionally filtered by URL(s).
	 *
	 * When `urls` is omitted or empty every cookie in the browser context is
	 * returned. When one or more URLs are supplied only cookies whose
	 * domain/path/secure attributes match are included.
	 */
	async cookies(urls?: string | string[]): Promise<Cookie[]> {
		this.assertOpen()
		return this.cookieManager.get(urls)
	}

	/**
	 * Add one or more cookies to the browser context.
	 *
	 * Each cookie must specify either a `url` (from which domain/path/secure are
	 * derived) or an explicit `domain` + `path` pair.
	 *
	 * We surface CDP errors if the browser rejects a cookie.
	 */
	async addCookies(cookies: CookieParam[]): Promise<void> {
		this.assertOpen()
		await this.cookieManager.add(cookies)
	}

	/**
	 * Clear cookies from the browser context.
	 *
	 * - Called with no arguments: clears **all** cookies atomically via
	 *   `Storage.clearCookies`.
	 * - Called with filter options: fetches all cookies, clears everything,
	 *   then re-adds only the cookies that do NOT match the filter via
	 *   `Storage.setCookies`. This is necessary on the browser endpoint because
	 *   the Storage domain does not support targeted deletes.
	 */
	async clearCookies(options?: ClearCookieOptions): Promise<void> {
		this.assertOpen()
		await this.cookieManager.clear(options)
	}
}
