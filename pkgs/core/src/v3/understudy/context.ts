import { v3ScriptContent } from "@handstage/dom/build/scriptV3Content"
import type { Protocol } from "devtools-protocol"
import { v3Logger } from "../logger"
import { getEnvTimeoutMs } from "../timeoutConfig"
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
	HandstagesSetExtraHTTPHeadersError,
	PageNotFoundError,
	TimeoutError,
} from "../types/public/sdkErrors"
import {
	type CDPSessionLike,
	type CDPConnectionLike,
	CDPConnection,
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
	const ti = info as unknown as { subtype?: string }
	return info.type === "page" && ti.subtype !== "iframe"
}

const DEFAULT_FIRST_TOP_LEVEL_PAGE_TIMEOUT_MS = 5000
const CI_FIRST_TOP_LEVEL_PAGE_TIMEOUT_MS = 30000
const FIRST_TOP_LEVEL_PAGE_TIMEOUT_ENV =
	"HANDSTAGES_FIRST_TOP_LEVEL_PAGE_TIMEOUT_MS"
const WAIT_FOR_FIRST_TOP_LEVEL_PAGE_OPERATION =
	"waitForFirstTopLevelPage (no top-level Page)"

function getFirstTopLevelPageTimeoutMs(): number {
	return (
		getEnvTimeoutMs(FIRST_TOP_LEVEL_PAGE_TIMEOUT_ENV) ??
		(process.env.CI
			? CI_FIRST_TOP_LEVEL_PAGE_TIMEOUT_MS
			: DEFAULT_FIRST_TOP_LEVEL_PAGE_TIMEOUT_MS)
	)
}

/**
 * V3Context
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

export class V3Context {
	private constructor(
		readonly conn: CDPConnectionLike,
		private readonly localBrowserLaunchOptions: LocalBrowserLaunchOptions | null = null,
		public readonly browserContextId: string,
		public readonly isDefaultContext: boolean = false,
	) {}

	private readonly _piercerInstalled = new Set<string>()
	// Timestamp for most recent popup/open signal
	private _lastPopupSignalAt = 0
	private readonly _targetSessionListeners = new Set<SessionId>()

	private readonly _sessionInit = new Set<SessionId>()
	private pagesByTarget = new Map<TargetId, Page>()
	private mainFrameToTarget = new Map<string, TargetId>()
	private sessionOwnerPage = new Map<SessionId, Page>()
	private frameOwnerPage = new Map<string, Page>()
	private pendingOopifByMainFrame = new Map<string, SessionId>()
	private createdAtByTarget = new Map<TargetId, number>()
	private typeByTarget = new Map<TargetId, TargetType>()
	private _pageOrder: TargetId[] = []
	private pendingCreatedTargetUrl = new Map<TargetId, string>()
	private readonly initScripts: string[] = []
	private extraHttpHeaders: Record<string, string> | null = null
	private _isClosed = false

	/**
	 * Child V3Contexts created via `createBrowserContext()`, tracked weakly
	 * so a forgotten close on a child doesn't keep it alive past GC.  The
	 * parent's `close()` walks this set and best-effort closes survivors so
	 * their per-page resources (NetworkManager, console handlers) are
	 * released before the shared CDP transport is torn down.
	 */
	private readonly _children = new Set<WeakRef<V3Context>>()

	/**
	 * Per-session disposer registry.  Holds every listener (or other
	 * teardown callback) this V3Context registered against a given child
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
				v3Logger({
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
	private _addSessionListener<P>(
		session: CDPSessionLike,
		event: string,
		handler: (params: P) => void,
	): void {
		const sessionId = session.id
		if (!sessionId) {
			throw new Error(
				"_addSessionListener requires a child CDP session with a non-null id; root-connection listeners must use this.conn.on() and be removed manually.",
			)
		}
		const erasedHandler = handler as unknown as (params: unknown) => void
		session.on(event, erasedHandler)
		this._registerSessionCleanup(sessionId, () =>
			session.off(event, erasedHandler),
		)
	}

	private installTargetSessionListeners(session: CDPSessionLike): void {
		const sessionId = session.id
		if (!sessionId) return
		if (this._targetSessionListeners.has(sessionId)) return
		this._targetSessionListeners.add(sessionId)

		this._addSessionListener<Protocol.Target.AttachedToTargetEvent>(
			session,
			"Target.attachedToTarget",
			(evt) => {
				void this.onAttachedToTarget(evt.targetInfo, evt.sessionId)
			},
		)
		this._addSessionListener<Protocol.Target.DetachedFromTargetEvent>(
			session,
			"Target.detachedFromTarget",
			(evt) => {
				this.onDetachedFromTarget(evt.sessionId, evt.targetId ?? null)
			},
		)
		this._addSessionListener<Protocol.Target.TargetDestroyedEvent>(
			session,
			"Target.targetDestroyed",
			(evt) => {
				this.cleanupByTarget(evt.targetId)
			},
		)
	}

	/**
	 * Create a Context for a given CDP websocket URL and bootstrap target wiring.
	 */
	static async create(
		wsUrl: string,
		opts?: {
			localBrowserLaunchOptions?: LocalBrowserLaunchOptions | null
			cdpHeaders?: Record<string, string>
		},
	): Promise<V3Context> {
		const conn = await CDPConnection.connect(wsUrl, {
			headers: opts?.cdpHeaders,
		})
		return V3Context.createFromConnection(conn, opts)
	}

	/**
	 * Discover the default `browserContextId` for an existing connection.
	 *
	 * Naively picking "the first page target with a `browserContextId`" is
	 * unsafe: in Chrome **every** page target — default-context or not —
	 * carries a `browserContextId`, so when we connect to a browser that
	 * already has dedicated contexts open we can mistakenly stamp a
	 * non-default id as the default.  That id then propagates everywhere
	 * (`isDefaultContext: true` + wrong id → `newPage()` times out,
	 * `Storage.*` operations target the wrong cookie jar, etc.).
	 *
	 * Strategy, in order:
	 *  1. Ask the browser for the IDs of all **non-default** contexts via
	 *     `Target.getBrowserContexts`.  Any existing page target whose id
	 *     is NOT in that list belongs to the default context.
	 *  2. If `getBrowserContexts` is unsupported, or no default-context
	 *     page exists yet, create a temporary `about:blank` target without
	 *     specifying `browserContextId` — by definition it lands in the
	 *     default context — read its id, then close it.
	 *
	 * `Target.getTargetInfo` is intentionally NOT used: when called on the
	 * browser endpoint without a `targetId` it returns the browser target
	 * itself, which has no `browserContextId`.
	 */
	private static async resolveDefaultBrowserContextId(
		conn: CDPConnectionLike,
	): Promise<string> {
		// Step 1: enumerate non-default context ids.  Some non-Chrome CDP
		// implementations don't expose this command; tolerate that.
		let nonDefaultIds: Set<string> | undefined
		try {
			const res = await conn.send<{ browserContextIds?: string[] }>(
				"Target.getBrowserContexts",
			)
			nonDefaultIds = new Set(res.browserContextIds ?? [])
		} catch (err) {
			v3Logger({
				category: "ctx",
				message:
					"Target.getBrowserContexts not available — falling back to temp-target discovery",
				level: LogLevel.Debug,
				attributes: { error: err instanceof Error ? err.message : String(err) },
			})
		}

		// Step 2 (fast path): pick any existing page target whose
		// browserContextId is NOT in the non-default set.
		if (nonDefaultIds) {
			try {
				const targets = await conn.getTargets()
				const defaultPage = targets.find(
					(t) =>
						t.type === "page" &&
						!!t.browserContextId &&
						!nonDefaultIds!.has(t.browserContextId),
				)
				if (defaultPage?.browserContextId) {
					return defaultPage.browserContextId
				}
			} catch (err) {
				v3Logger({
					category: "ctx",
					message: "Target.getTargets failed during default-context discovery",
					level: LogLevel.Debug,
					attributes: {
						error: err instanceof Error ? err.message : String(err),
					},
				})
			}
		}

		// Step 3 (slow path): create a temporary target.  Omitting
		// `browserContextId` forces Chrome to use the default context, so
		// the new target's `browserContextId` IS the default id.
		try {
			const { targetId } = await conn.send<{ targetId: string }>(
				"Target.createTarget",
				{ url: "about:blank" },
			)
			try {
				const after = await conn.getTargets()
				const probe = after.find((t) => t.targetId === targetId)
				if (probe?.browserContextId) return probe.browserContextId
			} finally {
				await conn
					.send("Target.closeTarget", { targetId })
					.catch((err) => {
						v3Logger({
							category: "ctx",
							message:
								"Failed to close temporary discovery target; it will remain until the browser exits",
							level: LogLevel.Debug,
							attributes: {
								targetId,
								error: err instanceof Error ? err.message : String(err),
							},
						})
					})
			}
		} catch (err) {
			throw new Error(
				`Failed to resolve default browserContextId via Target CDP commands: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		throw new Error(
			"Could not determine default browserContextId. The Target domain returned no usable context id.",
		)
	}

	/**
	 * Create a Context from an existing CDPConnectionLike.
	 */
	static async createFromConnection(
		conn: CDPConnectionLike,
		opts?: {
			localBrowserLaunchOptions?: LocalBrowserLaunchOptions | null
		},
	): Promise<V3Context> {
		const browserContextId =
			await V3Context.resolveDefaultBrowserContextId(conn)

		const ctx = new V3Context(
			conn,
			opts?.localBrowserLaunchOptions ?? null,
			browserContextId,
			true,
		)
		await ctx.bootstrap()
		await ctx.ensureFirstTopLevelPage(getFirstTopLevelPageTimeoutMs())
		return ctx
	}

	/**
	 * Create a new isolated browser context (similar to an incognito profile).
	 *
	 * The new context shares this context's CDP connection but has its own
	 * cookies, storage, and pages.  By default `disposeOnDetach: true` is set
	 * so Chrome auto-cleans the context if the connection drops unexpectedly.
	 *
	 * Init scripts and extra HTTP headers are NOT inherited from this context
	 * — call `addInitScript` / `setExtraHTTPHeaders` on the returned context
	 * if you want them.
	 *
	 * The returned context is also tracked weakly by this context so that
	 * if a caller forgets to `close()` it before the parent connection
	 * shuts down, `parent.close()` will best-effort close it for them.
	 *
	 * Note on scaling: every active V3Context registers its own root-level
	 * listeners on the shared connection, so each `Target.*` event fans out
	 * O(N) handlers (each filtering by `browserContextId`).  This is fine
	 * for a handful of contexts; if you need many dozens, consider sharing
	 * one context across tasks or batching their lifetimes.
	 */
	public async createBrowserContext(
		options?: CreateContextOptions,
	): Promise<V3Context> {
		const opts: CreateContextOptions = {
			disposeOnDetach: true,
			...options,
		}
		const { browserContextId } = await this.conn.send<{
			browserContextId: string
		}>("Target.createBrowserContext", opts)
		const ctx = new V3Context(
			this.conn,
			this.localBrowserLaunchOptions,
			browserContextId,
			false,
		)
		await ctx.bootstrap()
		if (!ctx.hasTopLevelPage()) {
			await ctx.newPage("about:blank")
		}
		this._trackChild(ctx)
		return ctx
	}

	private _trackChild(child: V3Context): void {
		// Sweep dead refs opportunistically to keep the set bounded.
		for (const ref of this._children) {
			if (!ref.deref()) this._children.delete(ref)
		}
		this._children.add(new WeakRef(child))
	}

	private hasTopLevelPage(): boolean {
		for (const [targetId, targetType] of this.typeByTarget) {
			if (targetType === "page" && this.pagesByTarget.has(targetId)) {
				return true
			}
		}
		return false
	}

	private async ensureFirstTopLevelPage(timeoutMs: number): Promise<void> {
		if (this.hasTopLevelPage()) return

		try {
			await this.waitForFirstTopLevelPage(timeoutMs)
			return
		} catch (err) {
			if (!(err instanceof TimeoutError)) {
				throw err
			}
			v3Logger({
				category: "ctx",
				message:
					"No open browser pages found after connect; creating an initial about:blank page",
				level: LogLevel.Info,
			})
		}

		await this.newPage("about:blank")
	}

	/**
	 * Wait until at least one top-level Page has been created and registered.
	 * We poll internal maps that bootstrap/onAttachedToTarget populate.
	 */
	private async waitForFirstTopLevelPage(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			// A top-level Page is present if typeByTarget has an entry "page"
			// and pagesByTarget has the corresponding Page object.
			for (const [tid, ttype] of this.typeByTarget) {
				if (ttype === "page") {
					const p = this.pagesByTarget.get(tid)
					if (p) return
				}
			}
			await new Promise((r) => setTimeout(r, 25))
		}
		throw new TimeoutError(WAIT_FOR_FIRST_TOP_LEVEL_PAGE_OPERATION, timeoutMs)
	}

	private async waitForInitialTopLevelTargets(
		targetIds: TargetId[],
		timeoutMs = 3000,
	): Promise<void> {
		if (!targetIds.length) return
		const pending = new Set(targetIds)
		const deadline = Date.now() + timeoutMs
		while (pending.size && Date.now() < deadline) {
			for (const tid of Array.from(pending)) {
				if (this.pagesByTarget.has(tid)) {
					pending.delete(tid)
				}
			}
			if (!pending.size) return
			await new Promise((r) => setTimeout(r, 25))
		}
		if (pending.size) {
			v3Logger({
				category: "ctx",
				message: "Timed out waiting for existing top-level targets to attach",
				level: LogLevel.Debug,
				attributes: {
					remainingTargets: Array.from(pending),
				},
			})
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

	/** Mark a page target as the most-recent one (active). */
	private _pushActive(tid: TargetId): void {
		// remove prior entry if any
		const i = this._pageOrder.indexOf(tid)
		if (i !== -1) this._pageOrder.splice(i, 1)
		this._pageOrder.push(tid)
	}

	/** Remove a page target from the recency list (used on close). */
	private _removeFromOrder(tid: TargetId): void {
		const i = this._pageOrder.indexOf(tid)
		if (i !== -1) this._pageOrder.splice(i, 1)
	}

	/** Return the current active Page (most-recent page that still exists). */
	public activePage(): Page | undefined {
		// prune any stale ids from the tail
		for (let i = this._pageOrder.length - 1; i >= 0; i--) {
			const tid = this._pageOrder[i]!
			const p = this.pagesByTarget.get(tid)
			if (p) return p
			// stale — remove and continue
			this._pageOrder.splice(i, 1)
		}
		// fallback: pick the newest by createdAt if order is empty
		let newestTid: TargetId | undefined
		let newestTs = -1
		for (const [tid] of this.pagesByTarget) {
			const ts = this.createdAtByTarget.get(tid) ?? 0
			if (ts > newestTs) {
				newestTs = ts
				newestTid = tid
			}
		}
		return newestTid ? this.pagesByTarget.get(newestTid) : undefined
	}

	/** Explicitly mark a known Page as the most-recent active page (and focus it). */
	public setActivePage(page: Page): void {
		let targetId = page.targetId()
		if (this.pagesByTarget.get(targetId) !== page) {
			const lookup = this.findTargetIdByPage(page)
			if (!lookup) {
				v3Logger({
					category: "ctx",
					message: "setActivePage called with unknown Page",
					level: LogLevel.Debug,
					attributes: { targetId },
				})
				return
			}
			targetId = lookup
		}

		this._pushActive(targetId)

		// Bring the tab to the foreground in headful Chrome (best effort).
		void this.conn.send("Target.activateTarget", { targetId }).catch(() => {})
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
			throw new HandstagesSetExtraHTTPHeadersError(failures)
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
		if (!this.isDefaultContext) {
			createParams.browserContextId = this.browserContextId
		}
		const { targetId } = await this.conn.send<{ targetId: string }>(
			"Target.createTarget",
			createParams,
		)
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

		// Drain any still-alive child contexts FIRST so their per-page
		// resources (NetworkManager, console handlers) are released before
		// the shared CDP transport goes away under them.  Errors during
		// child cleanup are swallowed by Promise.allSettled — a forgotten
		// child shouldn't block the parent's shutdown path.
		if (this._children.size > 0) {
			const liveChildren: V3Context[] = []
			for (const ref of this._children) {
				const child = ref.deref()
				if (child && !child._isClosed) liveChildren.push(child)
			}
			this._children.clear()
			if (liveChildren.length > 0) {
				await Promise.allSettled(liveChildren.map((c) => c.close()))
			}
		}

		this.conn.off("Target.attachedToTarget", this._onAttachedToTarget)
		this.conn.off("Target.detachedFromTarget", this._onDetachedFromTarget)
		this.conn.off("Target.targetDestroyed", this._onTargetDestroyed)
		this.conn.off("Target.targetCreated", this._onTargetCreated)

		// Drain every per-session cleanup that wasn't already run by an
		// earlier `Target.detachedFromTarget` event.  Iterating a snapshot
		// of the keys avoids invalidating the iterator inside
		// `_drainSessionCleanups()`.
		for (const sessionId of Array.from(this._sessionCleanups.keys())) {
			this._drainSessionCleanups(sessionId)
		}

		const pagesSnapshot = this.pages()
		await Promise.allSettled(pagesSnapshot.map((p) => p.close()))

		if (this.isDefaultContext) {
			await this.conn.close()
		} else {
			await this.conn
				.send("Target.disposeBrowserContext", {
					browserContextId: this.browserContextId,
				})
				.catch((err) => {
					v3Logger({
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

		this._sessionInit.clear()
		this._piercerInstalled.clear()
		this._targetSessionListeners.clear()
		this._pageOrder = []
		this.initScripts.length = 0
		this.extraHttpHeaders = null
	}

	// Filtering by `browserContextId` happens inside `onAttachedToTarget`
	// itself so that BOTH the root listener and per-session child-attach
	// listeners get the same isolation guarantee.
	private _onAttachedToTarget = async (
		evt: Protocol.Target.AttachedToTargetEvent,
	) => {
		if (this._isClosed) return
		await this.onAttachedToTarget(evt.targetInfo, evt.sessionId)
	}

	private _onDetachedFromTarget = (
		evt: Protocol.Target.DetachedFromTargetEvent,
	) => {
		if (this._isClosed) return
		this.onDetachedFromTarget(evt.sessionId, evt.targetId ?? null)
	}

	private _onTargetDestroyed = (evt: Protocol.Target.TargetDestroyedEvent) => {
		if (this._isClosed) return
		this.cleanupByTarget(evt.targetId)
	}

	// `Target.targetCreated` doesn't pass through `onAttachedToTarget`, so it
	// needs its own browser-context filter.
	private _onTargetCreated = async (
		evt: Protocol.Target.TargetCreatedEvent,
	) => {
		if (this._isClosed) return
		const info = evt.targetInfo
		if (info.browserContextId !== this.browserContextId) return
		const ti = info as unknown as { openerId?: string; openerFrameId?: string }
		if (info.type === "page" && (ti?.openerId || ti?.openerFrameId)) {
			this._notePopupSignal()
		}
	}

	/**
	 * Bootstrap target lifecycle:
	 * - Attach to existing targets.
	 * - Handle auto-attach events.
	 * - Clean up on detach/destroy.
	 */
	private async bootstrap(): Promise<void> {
		// Live attach via auto-attach (normal path)
		this.conn.on<Protocol.Target.AttachedToTargetEvent>(
			"Target.attachedToTarget",
			this._onAttachedToTarget,
		)

		// Live detach (clean up session from owner page & frame graph)
		this.conn.on<Protocol.Target.DetachedFromTargetEvent>(
			"Target.detachedFromTarget",
			this._onDetachedFromTarget,
		)

		// Destroyed targets (fallback cleanup by targetId)
		this.conn.on<Protocol.Target.TargetDestroyedEvent>(
			"Target.targetDestroyed",
			this._onTargetDestroyed,
		)

		this.conn.on<Protocol.Target.TargetCreatedEvent>(
			"Target.targetCreated",
			this._onTargetCreated,
		)

		// Only enable auto-attach after listeners are ready so replayed targets are captured.
		await this.conn.enableAutoAttach()

		const targets = await this.conn.getTargets()
		for (const t of targets) {
			if (t.browserContextId !== this.browserContextId) continue
			if (t.attached) continue // auto-attach already handled this target
			try {
				await this.conn.attachToTarget(t.targetId)
			} catch (err) {
				v3Logger({
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

		const topLevelTargetIds = targets
			.filter(
				(t) =>
					t.browserContextId === this.browserContextId && isTopLevelPage(t),
			)
			.map((t) => t.targetId)
		await this.waitForInitialTopLevelTargets(topLevelTargetIds)
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
	 * keeps multiple `V3Context` instances sharing one connection from
	 * cross-talking (otherwise both would manage every target).
	 */
	private async onAttachedToTarget(
		info: Protocol.Target.TargetInfo,
		sessionId: SessionId,
	): Promise<void> {
		if (this._isClosed) return

		// Reject anything not in our browser context.  This filter must run
		// before any state mutation because per-session listeners (installed
		// on parent sessions) will fire for OOPIF children regardless of which
		// context owns them, and we don't want to fight a sibling context for
		// ownership of someone else's target.
		if (info.browserContextId !== this.browserContextId) return

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

		this.installTargetSessionListeners(session)

		// Register for Runtime events before enabling it so we don't miss
		// initial contexts.  The disposer is tracked so we remove the
		// underlying `Runtime.*` handler registrations from the connection
		// when this session detaches or this V3Context closes.
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
		const queuePreResume = (
			method: string,
			params?: object,
			match?: (sentParams?: object) => boolean,
		) => {
			const dispatched = this.conn
				.waitForSessionDispatch(sessionId, method, match)
				.then(() => true)
				.catch(() => false)
			const response = session
				.send(method, params)
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
					queuePreResume(
						"Page.addScriptToEvaluateOnNewDocument",
						{
							source,
							runImmediately: true,
						},
						(sentParams) =>
							(sentParams as { source?: string } | undefined)?.source ===
							source,
					),
				)
			}
		}
		const piercerPreloadOp = queuePreResume(
			"Page.addScriptToEvaluateOnNewDocument",
			{
				source: v3ScriptContent,
				runImmediately: true,
			},
			(sentParams) =>
				(sentParams as { source?: string } | undefined)?.source ===
				v3ScriptContent,
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
				v3Logger({
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
					)
				} catch (error) {
					createError = error
				}
				if (!page) {
					v3Logger({
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
				this._pushActive(info.targetId)
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
				const { frameTree } =
					await session.send<Protocol.Page.GetFrameTreeResponse>(
						"Page.getFrameTree",
					)
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
				v3Logger({
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
		// lifetime of the V3Context.
		this._drainSessionCleanups(sessionId)

		this._targetSessionListeners.delete(sessionId)
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

		for (const [sid, p] of Array.from(this.sessionOwnerPage.entries())) {
			if (p === page) this.sessionOwnerPage.delete(sid)
		}

		for (const [fid] of Array.from(this.pendingOopifByMainFrame.entries())) {
			const owner = this.frameOwnerPage.get(fid)
			if (!owner || owner === page) this.pendingOopifByMainFrame.delete(fid)
		}

		this._removeFromOrder(targetId)
		this.pagesByTarget.delete(targetId)
		this.createdAtByTarget.delete(targetId)
		this.typeByTarget.delete(targetId)
		this.pendingCreatedTargetUrl.delete(targetId)
	}

	/**
	 * Wire Page-domain frame events for a session into the owning Page & mappings.
	 * We forward the *emitting session* with every event so Page can stamp ownership precisely.
	 */
	private installFrameEventBridges(sessionId: SessionId, owner: Page): void {
		const session = this.conn.getSession(sessionId)
		if (!session) return

		this._addSessionListener<Protocol.Page.FrameAttachedEvent>(
			session,
			"Page.frameAttached",
			(evt) => {
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
			},
		)

		this._addSessionListener<Protocol.Page.FrameDetachedEvent>(
			session,
			"Page.frameDetached",
			(evt) => {
				owner.onFrameDetached(evt.frameId, evt.reason ?? "remove")
				if (evt.reason !== "swap") {
					this.frameOwnerPage.delete(evt.frameId)
				}
			},
		)

		this._addSessionListener<Protocol.Page.FrameNavigatedEvent>(
			session,
			"Page.frameNavigated",
			(evt) => {
				owner.onFrameNavigated(evt.frame, session)
			},
		)

		this._addSessionListener<Protocol.Page.NavigatedWithinDocumentEvent>(
			session,
			"Page.navigatedWithinDocument",
			(evt) => {
				owner.onNavigatedWithinDocument(evt.frameId, evt.url, session)
			},
		)

		// Observe window.open to anticipate default page changes
		this._addSessionListener<Protocol.Page.WindowOpenEvent>(
			session,
			"Page.windowOpen",
			() => {
				this._notePopupSignal()
			},
		)
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

	private _notePopupSignal(): void {
		this._lastPopupSignalAt = Date.now()
	}

	/**
	 * Await the current active page, waiting briefly if a popup/open was just triggered.
	 * Normal path returns immediately; popup path waits up to timeoutMs for the new page.
	 */
	async awaitActivePage(timeoutMs?: number): Promise<Page> {
		const defaultTimeout = 2000
		timeoutMs = timeoutMs ?? defaultTimeout
		// If a popup was just triggered, Chrome may briefly pause new targets at document start.
		const recentWindowMs = 300
		const now = Date.now()
		const hasRecentPopup = now - this._lastPopupSignalAt <= recentWindowMs

		const immediate = this.activePage()
		if (!hasRecentPopup && immediate) return immediate

		const deadline = now + timeoutMs
		while (Date.now() < deadline) {
			// Prefer most-recent by createdAt
			let newestTid: TargetId | undefined
			let newestTs = -1
			for (const [tid] of this.pagesByTarget) {
				const ts = this.createdAtByTarget.get(tid) ?? 0
				if (ts > newestTs) {
					newestTs = ts
					newestTid = tid
				}
			}
			if (newestTid) {
				const p = this.pagesByTarget.get(newestTid)
				if (p && newestTs >= this._lastPopupSignalAt) return p
			}
			await new Promise((r) => setTimeout(r, 25))
		}
		if (immediate) return immediate
		throw new PageNotFoundError("awaitActivePage: no page available")
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
	private _scopedParams<T extends object>(extra?: T): T & { browserContextId?: string } {
		const out = { ...(extra ?? {}) } as T & { browserContextId?: string }
		if (!this.isDefaultContext) {
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

		const { cookies } = await this.conn.send<{
			cookies: Protocol.Network.Cookie[]
		}>("Storage.getCookies", this._scopedParams())

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
		const toKeep = current.filter((c) => !cookieMatchesFilter(c, options!))

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
