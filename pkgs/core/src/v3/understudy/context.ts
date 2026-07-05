import { v3ScriptContent } from "@handstage/dom/build/scriptV3Content"
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
	CookieSetError,
	CookieValidationError,
	HandstageSetExtraHTTPHeadersError,
	PageNotFoundError,
	TimeoutError,
} from "../types/public/sdkErrors"
import type {
	CDPCommand,
	CDPCommandParams,
	CDPConnectionLike,
	CDPEvent,
	CDPEventParams,
	CDPSessionLike,
} from "./cdp"
import {
	cookieMatchesFilter,
	filterCookies,
	normalizeCookieParams,
	toCDPCookieParam,
} from "./cookies"
import { executionContexts } from "./executionContextRegistry"
import { normalizeInitScriptSource } from "./initScripts"
import { Page } from "./page"
import { installV3PiercerIntoSession } from "./piercer"
import {
	getTargetRouter,
	type TargetRouter,
	type TargetRouterDelegate,
} from "./targetRouter"

type TargetId = string
type SessionId = string

type TargetType = "page" | "iframe" | string

/**
 * Returns true when the target's URL points to a document with a real,
 * pierceable HTML DOM.  We allowlist the small set of schemes that carry
 * web content rather than trying to blacklist every internal browser scheme
 * (chrome://, chrome-extension://, devtools://, brave://, edge://, …).
 */
function hasInjectableDOM(url: string | undefined): boolean {
	if (!url || url === "") return true
	if (
		url === "about:blank" ||
		url === "about:srcdoc" ||
		url.startsWith("about:blank#")
	)
		return true
	if (url.startsWith("http://") || url.startsWith("https://")) return true
	if (
		url.startsWith("data:") ||
		url.startsWith("blob:") ||
		url.startsWith("file://") ||
		url.startsWith("filesystem:")
	)
		return true
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
	}

	private readonly targetRouter: TargetRouter
	private routerUnsubscribe: (() => void) | null = null
	private knownNonDefaultBrowserContextIds: Set<string> | null = null
	private nonDefaultContextLookupFailed = false
	private readonly ownedTargetIds = new Set<TargetId>()

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
	private readonly _onCloseCallbacks = new Set<() => void>()

	public get isClosed(): boolean {
		return this._isClosed
	}

	/**
	 * Register a callback invoked exactly once after this context finishes
	 * closing.  Used by `Handstage` to drop closed contexts from its registry
	 * so long-lived instances don't retain every context ever created.
	 * If the context is already closed the callback fires immediately.
	 */
	public registerOnCloseCallback(cb: () => void): void {
		if (this._isClosed) {
			cb()
			return
		}
		this._onCloseCallbacks.add(cb)
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

	private _registerSessionCleanup(
		sessionId: SessionId,
		cleanup: SessionCleanup,
	): void {
		let cleanups = this._sessionCleanups.get(sessionId)
		if (!cleanups) {
			cleanups = []
			this._sessionCleanups.set(sessionId, cleanups)
		}
		cleanups.push(cleanup)
	}

	private _drainSessionCleanups(sessionId: SessionId): void {
		const cleanups = this._sessionCleanups.get(sessionId)
		if (!cleanups) return
		this._sessionCleanups.delete(sessionId)
		for (const c of cleanups) {
			try {
				c()
			} catch (err) {
				this.logger({
					category: "ctx",
					message: "Session cleanup callback threw",
					level: LogLevel.Debug,
					attributes: {
						sessionId,
						error: err instanceof Error ? err.message : String(err),
					},
				})
			}
		}
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
		},
	): Promise<Context> {
		return Context.createDefaultFromConnection(conn, opts)
	}

	static async createDefaultFromConnection(
		conn: CDPConnectionLike,
		opts?: {
			localBrowserLaunchOptions?: LocalBrowserLaunchOptions | null
			logger?: LogSink
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
		try {
			await ctx.bootstrap()
			return ctx
		} catch (err) {
			await ctx.close().catch(() => {})
			throw err
		}
	}

	static async createIsolatedFromConnection(
		conn: CDPConnectionLike,
		opts?: {
			localBrowserLaunchOptions?: LocalBrowserLaunchOptions | null
			createOptions?: CreateContextOptions
			logger?: LogSink
		},
	): Promise<Context> {
		const createOptions: CreateContextOptions = {
			disposeOnDetach: true,
			...opts?.createOptions,
		}
		const { browserContextId } = await conn.send(
			"Target.createBrowserContext",
			createOptions,
		)
		const ctx = new Context(
			conn,
			opts?.localBrowserLaunchOptions ?? null,
			browserContextId,
			false,
			true,
			opts?.logger,
		)
		try {
			await ctx.bootstrap()
			return ctx
		} catch (err) {
			await ctx.close().catch(() => {})
			throw err
		}
	}

	private async ensurePiercer(session: CDPSessionLike): Promise<boolean> {
		const id = session.id ?? ""
		if (this._piercerInstalled.has(id)) return true

		const installed = await installV3PiercerIntoSession(session)
		if (installed) {
			this._piercerInstalled.add(id)
		}
		return installed
	}

	public async addInitScript<Arg>(
		script: InitScriptSource<Arg>,
		arg?: Arg,
	): Promise<void> {
		const source = await normalizeInitScriptSource(script, arg)
		if (this.initScripts.includes(source)) return
		this.initScripts.push(source)
		const pages = this.pages()
		await Promise.all(pages.map((page) => page.registerInitScript(source)))
	}

	public async setExtraHTTPHeaders(
		headers: Record<string, string>,
	): Promise<void> {
		const nextHeaders = { ...headers }
		this.extraHttpHeaders = nextHeaders

		const sessions: CDPSessionLike[] = []
		for (const sessionId of this._sessionInit) {
			const session = this.conn.getSession(sessionId)
			if (session) sessions.push(session)
		}

		if (!sessions.length) return

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
				const reason = entry.result.reason as Error
				const sid = entry.session.id ?? "unknown"
				const message = reason?.message ?? String(reason)
				return `session=${sid} error=${message}`
			})

		if (failures.length) {
			throw new HandstageSetExtraHTTPHeadersError(failures)
		}
	}

	public async setDownloadBehavior(options: {
		downloadPath?: string
		acceptDownloads?: boolean
	}): Promise<void> {
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
		await this.conn.send("Browser.setDownloadBehavior", params)
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
		if (!owner) throw new PageNotFoundError(`mainFrameId=${rootMainFrameId}`)
		return owner.asProtocolFrameTree(rootMainFrameId)
	}

	/**
	 * Create a new top-level page (tab) with the given URL and return its Page object.
	 * Waits until the target is attached and registered.
	 */
	public async newPage(url = "about:blank"): Promise<Page> {
		const targetUrl = String(url ?? "about:blank")
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
		const { targetId } = await this.conn.send(
			"Target.createTarget",
			createParams,
		)
		this.ownedTargetIds.add(targetId)
		this.pendingCreatedTargetUrl.set(targetId, "about:blank")
		// Best-effort bring-to-front
		await this.conn.send("Target.activateTarget", { targetId }).catch(() => {})

		const deadline = Date.now() + 5000
		while (Date.now() < deadline) {
			const page = this.pagesByTarget.get(targetId)
			if (page) {
				// we created at about:blank; navigate only after attach so init scripts run
				// on the first real document. Fire-and-forget so newPage() resolves on attach.
				if (targetUrl !== "about:blank") {
					// Seed requested URL into the page cache before navigation events arrive.
					page.seedCurrentUrl(targetUrl)
					void page.sendCDP("Page.navigate", { url: targetUrl }).catch(() => {})
				}
				return page
			}
			await new Promise((r) => setTimeout(r, 25))
		}
		// The target never attached; drop the URL seed so the map doesn't grow
		// with entries no attach handler will ever consume.  `ownedTargetIds`
		// intentionally keeps the id: if the target attaches late we still own
		// it and must close it with the context.
		this.pendingCreatedTargetUrl.delete(targetId)
		throw new TimeoutError(`newPage: target not attached (${targetId})`, 5000)
	}

	/**
	 * Tear down this context.
	 *
	 * Order matters here:
	 *   1. Mark closed and detach **all** listeners first.  Otherwise, the
	 *      detach storms triggered by closing pages or disposing the browser
	 *      context fire `Target.detachedFromTarget` events that mutate state
	 *      we are about to wipe — risking dangling references or double-frees.
	 *   2. Close pages individually so each `Page` can dispose its
	 *      `NetworkManager`, console handlers, and other per-page resources.
	 *   3. Default context → close the underlying CDP connection.
	 *      Dedicated context → call `Target.disposeBrowserContext` so Chrome
	 *      releases the context's storage; the connection is shared and must
	 *      stay open for sibling contexts.
	 *   4. Drop all internal state.
	 */
	async close(): Promise<void> {
		if (this._isClosed) return
		this._isClosed = true

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
		if (this.isDefaultContext) {
			await Promise.allSettled(
				pagesSnapshot.map((p) =>
					this.ownedTargetIds.has(p.targetId())
						? p.close()
						: Promise.resolve(p.disposeResources()),
				),
			)
		} else {
			await Promise.allSettled(
				pagesSnapshot.map((p) => Promise.resolve(p.disposeResources())),
			)
		}

		// Dedicated contexts release their browser-side storage explicitly
		// so subsequent connections don't see stale cookies/local-storage.
		// Default contexts are shared with other actors on the same browser,
		// so we never call Target.disposeBrowserContext for them.
		//
		// We NEVER close the underlying CDP connection here — that is Handstage's
		// responsibility (or the caller's for shared connections).
		if (this.ownsBrowserContext && this.browserContextId) {
			await this.conn
				.send("Target.disposeBrowserContext", {
					browserContextId: this.browserContextId,
				})
				.catch((err) => {
					this.logger({
						category: "ctx",
						message: "Target.disposeBrowserContext failed during close",
						level: LogLevel.Debug,
						attributes: {
							browserContextId: this.browserContextId,
							error: err instanceof Error ? err.message : String(err),
						},
					})
				})
		}

		this.pagesByTarget.clear()
		this.mainFrameToTarget.clear()
		this.sessionOwnerPage.clear()
		this.frameOwnerPage.clear()
		this.pendingOopifByMainFrame.clear()
		this.createdAtByTarget.clear()
		this.typeByTarget.clear()
		this.pendingCreatedTargetUrl.clear()
		this.ownedTargetIds.clear()

		this._sessionInit.clear()
		this._piercerInstalled.clear()
		this.initScripts.length = 0
		this.extraHttpHeaders = null

		for (const cb of this._onCloseCallbacks) {
			try {
				cb()
			} catch {}
		}
		this._onCloseCallbacks.clear()
	}

	public async canClaimTarget(
		info: Protocol.Target.TargetInfo,
	): Promise<boolean> {
		if (this._isClosed) return false
		if (!this.isDefaultContext) {
			return (
				!!this.browserContextId &&
				info.browserContextId === this.browserContextId
			)
		}

		const targetContextId = info.browserContextId
		if (!targetContextId) return true
		if (this.browserContextId && targetContextId === this.browserContextId) {
			return true
		}

		// Fast path cache check
		if (this.knownNonDefaultBrowserContextIds?.has(targetContextId))
			return false

		// For default context routing, if the target has an explicit browserContextId
		// that we haven't seen, we must verify if it's a known non-default context
		// before claiming it. If we can't fetch contexts, we fall back to learning.
		let nonDefaultIds = await this.getNonDefaultBrowserContextIds()
		if (nonDefaultIds?.has(targetContextId)) return false
		if (nonDefaultIds) {
			// Cache miss - maybe it's a newly created context? Refresh and check again.
			nonDefaultIds = await this.refreshNonDefaultBrowserContextIds()
			if (nonDefaultIds?.has(targetContextId)) return false
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
		if (this._isClosed) return
		this.onDetachedFromTarget(sessionId, targetId)
	}

	public onRouterTargetDestroyed(targetId: string): void {
		if (this._isClosed) return
		this.cleanupByTarget(targetId)
	}

	private async getNonDefaultBrowserContextIds(): Promise<Set<string> | null> {
		if (this.knownNonDefaultBrowserContextIds) {
			return this.knownNonDefaultBrowserContextIds
		}
		if (this.nonDefaultContextLookupFailed) return null

		try {
			const res = await this.conn.send("Target.getBrowserContexts")
			this.knownNonDefaultBrowserContextIds = new Set(
				res.browserContextIds ?? [],
			)
			return this.knownNonDefaultBrowserContextIds
		} catch (err) {
			this.nonDefaultContextLookupFailed = true
			this.logger({
				category: "ctx",
				message:
					"Target.getBrowserContexts not available — default-context target matching will learn the first observed context id",
				level: LogLevel.Debug,
				attributes: { error: err instanceof Error ? err.message : String(err) },
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
		this.routerUnsubscribe = await this.targetRouter.register(this, this.logger)

		const targets = await this.conn.getTargets()
		for (const t of targets) {
			if (!(await this.canClaimTarget(t))) continue
			if (t.attached) continue // auto-attach already handled this target
			try {
				await this.conn.attachToTarget(t.targetId)
			} catch (err) {
				this.logger({
					category: "ctx",
					message: "Failed to attach to existing target during bootstrap",
					level: LogLevel.Debug,
					attributes: {
						targetId: t.targetId,
						targetType: t.type,
						error: err instanceof Error ? err.message : String(err),
					},
				})
			}
		}
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
		if (this._isClosed) return

		// TargetRouter should only call us for owned targets.  Keep a defensive
		// ownership check here so direct/internal calls do not accidentally
		// mutate this context for a sibling browser context.
		if (!(await this.canClaimTarget(info))) {
			const foreignSession = this.conn.getSession(sessionId)
			if (foreignSession) {
				await foreignSession
					.send("Runtime.runIfWaitingForDebugger")
					.catch(() => {})
			}
			return
		}

		// Skip non-web targets (workers, chrome extensions, background pages, etc.).
		// They still need to be resumed so we don't leave them paused by
		// waitForDebuggerOnStart, but injecting the piercer into these targets
		// can throw or corrupt their internal state (e.g. Chrome's PDF viewer).
		if (isNonWebTarget(info)) {
			const session = this.conn.getSession(sessionId)
			if (session) {
				await session.send("Runtime.runIfWaitingForDebugger").catch(() => {})
			}
			return
		}

		const session = this.conn.getSession(sessionId)
		if (!session) return

		// Init guard
		if (this._sessionInit.has(sessionId)) return
		this._sessionInit.add(sessionId)

		// Register for Runtime events before enabling it so we don't miss
		// initial contexts.  The disposer is tracked so we remove the
		// underlying `Runtime.*` handler registrations from the connection
		// when this session detaches or this Context closes.
		const detachExec = executionContexts.attachSession(session)
		this._registerSessionCleanup(sessionId, detachExec)

		// Ensure we only resume once even if multiple code paths hit finally.
		let resumed = false
		const resume = async (): Promise<void> => {
			if (resumed) return
			resumed = true
			// waitForDebuggerOnStart pauses new targets; resume once we've done
			// any "must happen before first document" work.
			await session.send("Runtime.runIfWaitingForDebugger").catch(() => {})
		}

		// Attach lifecycle (per target session):
		// 1) while paused, enable domains + child auto-attach and register init scripts;
		// 2) resume target execution;
		// 3) build/adopt Page ownership and frame bridges.
		// Some CDP backends defer *.enable() responses until after resume, so we
		// cannot await those responses before resuming. Instead we:
		// - wait for transport-level dispatch of required pre-resume commands;
		// - then dispatch resume;
		// - then await responses.
		const queuePreResume = <M extends CDPCommand>(
			method: M,
			...params: CDPCommandParams<M>
		) => {
			const dispatched = this.conn
				.waitForSessionDispatch(sessionId, method, ...params)
				.then(() => true)
				.catch(() => false)
			const response = session
				.send(method, ...params)
				.then(() => true)
				.catch(() => false)
			return { dispatched, response }
		}
		const initScriptOps: Array<{
			dispatched: Promise<boolean>
			response: Promise<boolean>
		}> = []
		// Pre-resume ordering matters:
		// - enable domains;
		// - enable child auto-attach with waitForDebuggerOnStart;
		// - register init scripts.
		// Commands are sent in-order on the same session before resume.
		const corePreResumeOps = [
			queuePreResume("Page.enable"),
			queuePreResume("Runtime.enable"),
			queuePreResume("Target.setAutoAttach", {
				autoAttach: true,
				waitForDebuggerOnStart: true,
				flatten: true,
			}),
		]
		const headerPreResumeOps: Array<{
			dispatched: Promise<boolean>
			response: Promise<boolean>
		}> = []
		if (this.extraHttpHeaders) {
			const headers = { ...this.extraHttpHeaders }
			headerPreResumeOps.push(queuePreResume("Network.enable"))
			headerPreResumeOps.push(
				queuePreResume("Network.setExtraHTTPHeaders", { headers }),
			)
		}
		// Send init scripts only after auto-attach has been queued.
		if (this.initScripts.length) {
			for (const source of this.initScripts) {
				initScriptOps.push(
					queuePreResume("Page.addScriptToEvaluateOnNewDocument", {
						source,
						runImmediately: true,
					}),
				)
			}
		}
		const piercerPreloadOp = queuePreResume(
			"Page.addScriptToEvaluateOnNewDocument",
			{
				source: v3ScriptContent,
				runImmediately: true,
			},
		)
		const preResumeDispatched = (
			await Promise.all([
				...corePreResumeOps.map((op) => op.dispatched),
				...headerPreResumeOps.map((op) => op.dispatched),
				...initScriptOps.map((op) => op.dispatched),
				piercerPreloadOp.dispatched,
			])
		).every(Boolean)
		// Dispatch resume only after pre-resume setup has actually been sent.
		const resumeOp = queuePreResume("Runtime.runIfWaitingForDebugger")
		const [resumedDispatched, resumedOk] = await Promise.all([
			resumeOp.dispatched,
			resumeOp.response,
		])
		const [
			coreResults,
			headerResults,
			initScriptResults,
			piercerPreRegistered,
		] = await Promise.all([
			Promise.all(corePreResumeOps.map((op) => op.response)),
			Promise.all(headerPreResumeOps.map((op) => op.response)),
			Promise.all(initScriptOps.map((op) => op.response)),
			piercerPreloadOp.response,
		])
		// Header propagation is independent of init-script determinism but still
		// part of pre-resume attach setup; awaited above for ordering/lifecycle.
		void headerResults
		if (!preResumeDispatched || !resumedDispatched || !resumedOk) {
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
						preResumeDispatched,
						resumedDispatched,
						resumedOk,
					},
				})
			}
			return
		}
		resumed = true
		const scriptsInstalled =
			coreResults.every(Boolean) && initScriptResults.every(Boolean)

		try {
			// Best-effort lifecycle events; do not block top-level page registration
			// on this optional signal stream.
			void session
				.send("Page.setLifecycleEventsEnabled", { enabled: true })
				.catch(() => {})

			// Top-level handling
			if (isTopLevelPage(info)) {
				let page: Page | null = null
				let createError: unknown
				// Deterministic contract: never drop a newly attached top-level target
				// because an arbitrary local timeout fired. We wait for Page.create and
				// let it finish regardless of CDP call latency.
				try {
					page = await Page.create(
						this.conn,
						session,
						info.targetId,
						this.localBrowserLaunchOptions,
						this.logger,
					)
				} catch (error) {
					createError = error
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
							error:
								createError instanceof Error
									? createError.message
									: String(createError),
						},
					})
					return
				}
				this.wireSessionToOwnerPage(sessionId, page)
				this.pagesByTarget.set(info.targetId, page)
				this.mainFrameToTarget.set(page.mainFrameId(), info.targetId)
				this.sessionOwnerPage.set(sessionId, page)
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
				// If we already installed scripts at the session level, only seed the
				// Page's registry to avoid double-installing DOMContentLoaded handlers.
				await this.applyInitScriptsToPage(page, {
					seedOnly: scriptsInstalled,
				})
				if (!piercerPreRegistered) {
					void this.ensurePiercer(session).catch(() => {})
				}

				return
			}

			const piercerReady = await this.ensurePiercer(session).catch(() => false)
			if (!piercerReady) return

			// Child (iframe / OOPIF)
			try {
				const { frameTree } = await session.send("Page.getFrameTree")
				const childMainId = frameTree.frame.id

				// Try to find owner Page now (it may already have the node in its tree)
				let owner = this.frameOwnerPage.get(childMainId)
				if (!owner) {
					for (const p of this.pagesByTarget.values()) {
						const tree = p.asProtocolFrameTree(p.mainFrameId())
						const has = (function find(n: Protocol.Page.FrameTree): boolean {
							if (n.frame.id === childMainId) return true
							for (const c of n.childFrames ?? []) if (find(c)) return true
							return false
						})(tree)
						if (has) {
							owner = p
							break
						}
					}
				}

				if (owner) {
					owner.adoptOopifSession(session, childMainId)
					this.sessionOwnerPage.set(sessionId, owner)
					this.installFrameEventBridges(sessionId, owner)
					// Prime the execution-context registry so later lookups succeed even if
					// the frame navigates before we issue a command.
					void executionContexts
						.waitForMainWorld(session, childMainId)
						.catch(() => {})
				} else {
					this.pendingOopifByMainFrame.set(childMainId, sessionId)
				}
			} catch (err) {
				// Most often a short-lived ad iframe that opened and closed
				// before we could probe its frame tree. Log at Debug for
				// visibility but don't surface — this is expected at
				// non-trivial frequency on real-world pages.
				this.logger({
					category: "ctx",
					message: "OOPIF Page.getFrameTree failed during attach",
					level: LogLevel.Debug,
					attributes: {
						targetId: info.targetId,
						error: err instanceof Error ? err.message : String(err),
					},
				})
			}
		} finally {
			await resume()
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
			owner.detachOopifSession(sessionId)
			this.sessionOwnerPage.delete(sessionId)
		}

		if (targetId && this.pagesByTarget.has(targetId)) {
			this.cleanupByTarget(targetId)
		}

		for (const [fid, sid] of Array.from(
			this.pendingOopifByMainFrame.entries(),
		)) {
			if (sid === sessionId) this.pendingOopifByMainFrame.delete(fid)
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

	/**
	 * Cleanup a top-level Page by target id, removing its root and staged children.
	 */
	private cleanupByTarget(targetId: TargetId): void {
		const page = this.pagesByTarget.get(targetId)
		if (!page) return

		const mainId = page.mainFrameId()
		this.mainFrameToTarget.delete(mainId)
		this.frameOwnerPage.delete(mainId)

		for (const [fid, p] of Array.from(this.frameOwnerPage.entries())) {
			if (p === page) this.frameOwnerPage.delete(fid)
		}

		for (const [sid, p] of Array.from(this.sessionOwnerPage.entries())) {
			if (p === page) this.sessionOwnerPage.delete(sid)
		}

		for (const [fid] of Array.from(this.pendingOopifByMainFrame.entries())) {
			const owner = this.frameOwnerPage.get(fid)
			if (!owner || owner === page) this.pendingOopifByMainFrame.delete(fid)
		}

		page.disposeResources()
		this.pagesByTarget.delete(targetId)
		this.createdAtByTarget.delete(targetId)
		this.typeByTarget.delete(targetId)
		this.pendingCreatedTargetUrl.delete(targetId)
		this.ownedTargetIds.delete(targetId)
	}

	/**
	 * Wire Page-domain frame events for a session into the owning Page & mappings.
	 * We forward the *emitting session* with every event so Page can stamp ownership precisely.
	 */
	private installFrameEventBridges(sessionId: SessionId, owner: Page): void {
		const session = this.conn.getSession(sessionId)
		if (!session) return

		this._addSessionListener(session, "Page.frameAttached", (evt) => {
			const { frameId, parentFrameId } = evt

			owner.onFrameAttached(frameId, parentFrameId ?? null, session)

			// If we were waiting for this id (OOPIF child), adopt now.
			const pendingChildSessionId = this.pendingOopifByMainFrame.get(frameId)
			if (pendingChildSessionId) {
				const child = this.conn.getSession(pendingChildSessionId)
				if (child) {
					owner.adoptOopifSession(child, frameId)
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
					this.mainFrameToTarget.set(newRoot, topTargetId)
				}
				this.frameOwnerPage.set(newRoot, owner)
			}
		})

		this._addSessionListener(session, "Page.frameDetached", (evt) => {
			owner.onFrameDetached(evt.frameId, evt.reason ?? "remove")
			if (evt.reason !== "swap") {
				this.frameOwnerPage.delete(evt.frameId)
			}
		})

		this._addSessionListener(session, "Page.frameNavigated", (evt) => {
			owner.onFrameNavigated(evt.frame, session)
		})

		this._addSessionListener(session, "Page.navigatedWithinDocument", (evt) => {
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
			if (p === page) return tid
		}
		return undefined
	}

	/**
	 * Build a CDP params object that is scoped to this context's
	 * `browserContextId` — but only when this is a dedicated context.
	 *
	 * Chrome's Storage domain rejects an explicit `browserContextId` for
	 * the *default* context (the parameter is meant to address non-default
	 * contexts). Passing it would yield `-32602 Failed to find browser
	 * context for id ...`.
	 */
	private _scopedParams<T extends object>(
		extra?: T,
	): T & { browserContextId?: string } {
		const out = { ...(extra ?? {}) } as T & { browserContextId?: string }
		if (!this.isDefaultContext && this.browserContextId) {
			out.browserContextId = this.browserContextId
		}
		return out
	}

	/**
	 * Get all browser cookies, optionally filtered by URL(s).
	 *
	 * When `urls` is omitted or empty every cookie in the browser context is
	 * returned. When one or more URLs are supplied only cookies whose
	 * domain/path/secure attributes match are included.
	 */
	async cookies(urls?: string | string[]): Promise<Cookie[]> {
		const urlList = !urls ? [] : typeof urls === "string" ? [urls] : urls

		const { cookies } = await this.conn.send(
			"Storage.getCookies",
			this._scopedParams(),
		)

		const mapped: Cookie[] = cookies.map((c) => ({
			name: c.name,
			value: c.value,
			domain: c.domain,
			path: c.path,
			expires: c.expires,
			httpOnly: c.httpOnly,
			secure: c.secure,
			sameSite: (c.sameSite as Cookie["sameSite"]) ?? "Lax",
		}))

		return filterCookies(mapped, urlList)
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
		const normalized = normalizeCookieParams(cookies)
		if (!normalized.length) return

		const cdpCookies = normalized.map(toCDPCookieParam)

		try {
			await this.conn.send(
				"Storage.setCookies",
				this._scopedParams({ cookies: cdpCookies }),
			)
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err)
			const names = normalized.map((c) => `"${c.name}"`).join(", ")
			throw new CookieSetError(
				`Failed to set cookies [${names}] — ` +
					`the browser rejected the batch. Check that the domain, path, and secure/sameSite values are valid.` +
					(detail ? ` (CDP error: ${detail})` : ""),
			)
		}
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
		const hasFilter =
			options?.name !== undefined ||
			options?.domain !== undefined ||
			options?.path !== undefined

		if (!hasFilter) {
			// Atomic single-call wipe — no race condition, no O(N) roundtrips.
			await this.conn.send("Storage.clearCookies", this._scopedParams())
			return
		}

		const current = await this.cookies()
		if (!options) {
			throw new CookieValidationError("clearCookies filter options are missing")
		}
		const toKeep = current.filter((c) => !cookieMatchesFilter(c, options))

		if (toKeep.length === current.length) return

		// Storage domain doesn't support targeted deletes on the browser endpoint.
		// Clear everything, then re-add only the cookies we're keeping.
		await this.conn.send("Storage.clearCookies", this._scopedParams())
		if (toKeep.length) {
			try {
				await this.conn.send(
					"Storage.setCookies",
					this._scopedParams({ cookies: toKeep.map(toCDPCookieParam) }),
				)
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err)
				const names = toKeep.map((c) => `"${c.name}"`).join(", ")
				throw new CookieSetError(
					`clearCookies: cookies were cleared but failed to re-add the ${toKeep.length} ` +
						`non-matching cookie(s) [${names}]. The browser cookie jar is now empty. ` +
						(detail ? `(CDP error: ${detail})` : ""),
				)
			}
		}
	}
}
