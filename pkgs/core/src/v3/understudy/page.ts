import { promises as fs } from "node:fs"
import type { Protocol } from "devtools-protocol"
import { defaultLogger, type LogSink } from "../logger"
import type { InitScriptSource } from "../types/private/index"
import {
	HandstageSetExtraHTTPHeadersError,
	HandstageSnapshotError,
	type LocalBrowserLaunchOptions,
} from "../types/public/index"
import { LogLevel } from "../types/public/logs"
import type {
	LoadState,
	PageSnapshotOptions,
	SnapshotResult,
} from "../types/public/page"
import type {
	ScreenshotAnimationsOption,
	ScreenshotCaretOption,
	ScreenshotOptions,
	ScreenshotScaleOption,
} from "../types/public/screenshotTypes"
import {
	CDPConnectionClosedError,
	HandstageInvalidArgumentError,
	TimeoutError,
} from "../types/public/sdkErrors"
import { captureHybridSnapshot } from "./a11y/snapshot/index"
import {
	type CDPCommand,
	type CDPCommandParams,
	type CDPCommandResult,
	type CDPConnectionLike,
	type CDPSessionLike,
	sendCDPWithSignal,
	sendCDPWithSignalAndLateResult,
} from "./cdp"
import { type ConsoleListener, ConsoleMessage } from "./consoleMessage"
import { deepLocatorFromPage, resolveLocatorTarget } from "./deepLocator"
import { executionContexts } from "./executionContextRegistry"
import { Frame } from "./frame"
import { FrameLocator } from "./frameLocator"
import { FrameRegistry } from "./frameRegistry"
import { normalizeInitScriptSource } from "./initScripts"
import { Keyboard } from "./keyboard"
import { LifecycleWatcher } from "./lifecycleWatcher"
import type { Locator } from "./locator"
import { buildLocatorInvocation } from "./locatorInvocation"
import { Mouse } from "./mouse"
import { NavigationResponseTracker } from "./navigationResponseTracker"
import { NetworkManager } from "./networkManager"
import { errorMessage } from "./protocolError"
import type { Response } from "./response"
import {
	raceCleanupAgainstAbort,
	releaseDiscardedEvaluationHandles,
	releaseObjectGroup,
	releaseObjectIds,
} from "./runtimeObjectUtils"
import { ScreenshotCleanupScope } from "./screenshotCleanup"
import {
	applyMaskOverlays,
	applyStyleToFrames,
	collectFramesForScreenshot,
	computeScreenshotScale,
	disableAnimations,
	hideCaret,
	normalizeScreenshotClip,
	setTransparentBackground,
} from "./screenshotUtils"
import { closeTargetAndConfirm } from "./targetLifecycle"

/**
 * Page
 *
 * One instance per **top-level target**. It owns:
 *  - the top-level CDP session (for the page target)
 *  - all adopted OOPIF child sessions (Target.attachToTarget with flatten: true)
 *  - a **FrameRegistry** that is the single source of truth for BOTH:
 *      • frame topology (parent/children, root swaps, last-seen CDP Frame)
 *      • frame → session ownership (which session owns which frameId)
 *
 * Page exposes convenient APIs (goto/reload/url/screenshot/locator),
 * and simple bridges that Context uses to feed Page/Target events in.
 */

const LIFECYCLE_NAME: Record<LoadState, string> = {
	load: "load",
	domcontentloaded: "DOMContentLoaded",
	networkidle: "networkIdle",
}

let pageRuntimeProbeObjectGroupSequence = 0

function createDeadlineSignal(
	parent: AbortSignal,
	operation: string,
	timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController()
	const timeout = Math.max(0, timeoutMs)
	const timer =
		Number.isFinite(timeout) && timeout > 0
			? setTimeout(
					() => controller.abort(new TimeoutError(operation, timeout)),
					timeout,
				)
			: null
	return {
		signal: AbortSignal.any([parent, controller.signal]),
		dispose: () => {
			if (timer) {
				clearTimeout(timer)
			}
		},
	}
}

type InitialNavigationState = {
	settled: Promise<void>
	resolveSettled: () => void
	superseded: boolean
	finished: boolean
}

type NavigationReservation = {
	id: number
	signal: AbortSignal
}

export class Page {
	/** Every CDP child session this page owns (top-level + adopted OOPIF sessions). */
	private readonly sessions = new Map<string, CDPSessionLike>() // sessionId -> session

	/** Unified truth for frame topology + ownership. */
	private readonly registry: FrameRegistry

	/** A convenience wrapper bound to the current main frame id (top-level session). */
	private mainFrameWrapper: Frame

	/** Compact ordinal per frameId (used by snapshot encoding). */
	private frameOrdinals = new Map<string, number>()
	private nextOrdinal = 0

	/** cache Frames per frameId so everyone uses the same one */
	private readonly frameCache = new Map<string, Frame>()

	/** Stable id for Frames created by this Page (use top-level TargetId). */
	public readonly pageId: string
	/** Cached current URL for synchronous page.url() */
	private _currentUrl: string = "about:blank"

	private navigationCommandSeq = 0
	private latestNavigationCommandId = 0
	private pendingNavigationReservation: {
		id: number
		controller: AbortController
	} | null = null
	private activeNavigationController: AbortController | null = null
	private readonly activeNavigationLoaderIds = new Set<string>()
	private readonly supersededNavigationLoaderIds = new Set<string>()
	private pendingInitialNavigation: InitialNavigationState | null = null
	private initialNavigationLoaderId: string | null = null
	private mainFrameNavigationVersion = 0

	private readonly networkManager: NetworkManager
	private readonly keyboard: Keyboard
	private readonly mouse: Mouse
	private readonly consoleListeners = new Set<ConsoleListener>()
	private readonly consoleHandlers = new Map<
		string,
		(evt: Protocol.Runtime.ConsoleAPICalledEvent) => void
	>()
	/** Document-start scripts installed across every session this page owns. */
	private readonly initScripts: string[] = []
	private extraHTTPHeaders: Record<string, string> = {}
	private disposed = false
	private closing = false
	private closePromise: Promise<void> | null = null
	private readonly disposeController = new AbortController()
	private readonly activeLifecycleWaitCleanups = new Set<
		(error: Error) => void
	>()
	private readonly closeCallbacks = new Set<() => void>()

	private assertOpen(): void {
		if (this.disposed || this.closing) {
			throw new CDPConnectionClosedError(
				this.disposed ? "page is disposed" : "page is closing",
			)
		}
	}

	private async delay(ms: number): Promise<void> {
		const timeout = Math.max(0, Number(ms) || 0)
		const signal = this.disposeController.signal
		if (signal.aborted) {
			throw signal.reason
		}
		if (timeout === 0) {
			return
		}
		await new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
				timer = null
				signal.removeEventListener("abort", onAbort)
				resolve()
			}, timeout)
			const onAbort = () => {
				if (timer === null) {
					return
				}
				clearTimeout(timer)
				timer = null
				signal.removeEventListener("abort", onAbort)
				reject(
					signal.reason instanceof Error
						? signal.reason
						: new CDPConnectionClosedError("page is disposed"),
				)
			}
			signal.addEventListener("abort", onAbort, { once: true })
		})
	}

	/** Per-instance debug log sink — fans out to sub-managers (NetworkManager, etc.). */
	public readonly logger: LogSink

	private constructor(
		private readonly conn: CDPConnectionLike,
		private readonly mainSession: CDPSessionLike,
		private readonly _targetId: string,
		mainFrameId: string,
		logger?: LogSink,
	) {
		this.pageId = _targetId
		this.logger = logger ?? defaultLogger()

		// own the main session
		if (mainSession.id) {
			this.sessions.set(mainSession.id, mainSession)
		}

		// initialize registry with root/main frame id
		this.registry = new FrameRegistry(_targetId, mainFrameId)

		// main-frame wrapper is always bound to the **top-level** session
		this.mainFrameWrapper = new Frame(
			this.mainSession,
			mainFrameId,
			this.pageId,
			false,
			this.logger,
			this.disposeController.signal,
		)

		this.networkManager = new NetworkManager()
		this.keyboard = new Keyboard(this.mainSession, (delayMs) =>
			this.delay(delayMs),
		)
		this.mouse = new Mouse(this, this.mainSession, this.logger, (delayMs) =>
			this.delay(delayMs),
		)
		try {
			this.networkManager.trackSession(this.mainSession)
			this.installConsoleTap(this.mainSession)
		} catch (error) {
			this.networkManager.dispose()
			throw error
		}
	}

	// Send a single init script to a specific CDP session.
	private async installInitScriptOnSession(
		session: CDPSessionLike,
		source: string,
	): Promise<void> {
		await session.send("Page.addScriptToEvaluateOnNewDocument", {
			source: source,
		})
	}

	// Replay every previously registered init script onto a newly adopted session.
	private async applyInitScriptsToSession(
		session: CDPSessionLike,
	): Promise<void> {
		for (const source of this.initScripts) {
			await this.installInitScriptOnSession(session, source)
		}
	}

	// Register a new init script and fan it out to all active sessions for this page.
	public async registerInitScript(source: string): Promise<void> {
		this.assertOpen()
		if (this.initScripts.includes(source)) {
			return
		}
		this.initScripts.push(source)

		const installs: Array<Promise<void>> = []
		installs.push(this.installInitScriptOnSession(this.mainSession, source))
		for (const session of this.sessions.values()) {
			if (session === this.mainSession) {
				continue
			}
			installs.push(this.installInitScriptOnSession(session, source))
		}
		await Promise.all(installs)
	}

	// Seed an init script without re-installing it on the current sessions.
	public seedInitScript(source: string): void {
		if (this.initScripts.includes(source)) {
			return
		}
		this.initScripts.push(source)
	}

	public async enableCursorOverlay(): Promise<void> {
		this.assertOpen()
		await this.mouse.enableCursorOverlay()
	}

	public async addInitScript<Arg>(
		script: InitScriptSource<Arg>,
		arg?: Arg,
	): Promise<void> {
		const source = await normalizeInitScriptSource(
			script,
			arg,
			"page.addInitScript",
		)
		await this.registerInitScript(source)
	}

	/**
	 * Factory: create Page and seed registry with the shallow tree from Page.getFrameTree.
	 * Assumes Page domain is already enabled on the session passed in.
	 */
	static async create(
		conn: CDPConnectionLike,
		session: CDPSessionLike,
		targetId: string,
		localBrowserLaunchOptions?: LocalBrowserLaunchOptions | null,
		logger?: LogSink,
		signal?: AbortSignal,
	): Promise<Page> {
		// Context already issues Page.enable + lifecycle enable before resume.
		// Re-issue here only as best-effort and do not block page registration on
		// their acknowledgements; some remote CDP backends can delay these replies
		// long after the target is otherwise ready.
		const send = <M extends CDPCommand>(
			method: M,
			...params: CDPCommandParams<M>
		) =>
			signal
				? sendCDPWithSignal(session, method, signal, ...params)
				: session.send(method, ...params)
		void send("Page.enable").catch(() => {})
		void send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(
			() => {},
		)
		const { frameTree } = await send("Page.getFrameTree")
		const mainFrameId = frameTree.frame.id

		const page = new Page(conn, session, targetId, mainFrameId, logger)
		// Seed current URL from initial frame tree
		page._currentUrl = String(frameTree?.frame?.url ?? page._currentUrl)
		if (localBrowserLaunchOptions?.viewport) {
			try {
				await page.setViewportSize(
					localBrowserLaunchOptions.viewport.width,
					localBrowserLaunchOptions.viewport.height,
					{
						deviceScaleFactor: localBrowserLaunchOptions.deviceScaleFactor ?? 1,
						signal,
					},
				)
			} catch (error) {
				page.disposeResources()
				throw error
			}
		}

		// Seed topology + ownership for nodes known at creation time.
		page.registry.seedFromFrameTree(session.id ?? "root", frameTree)

		return page
	}

	// ---------------- Event-driven updates from Context ----------------

	/**
	 * Parent/child session emitted a `frameAttached`.
	 * Topology update + ownership stamped to **emitting session**.
	 */
	public onFrameAttached(
		frameId: string,
		parentId: string | null,
		session: CDPSessionLike,
	): void {
		this.ensureOrdinal(frameId)
		const prevRoot = this.registry.mainFrameId()
		this.registry.onFrameAttached(frameId, parentId, session.id ?? "root")
		// On a root swap, drop the caches for the old root id.
		const newRoot = this.registry.mainFrameId()
		if (newRoot !== prevRoot) {
			this.frameOrdinals.delete(prevRoot)
			this.frameCache.delete(prevRoot)
			this.mainFrameWrapper = new Frame(
				this.mainSession,
				newRoot,
				this.pageId,
				false,
				this.logger,
				this.disposeController.signal,
			)
		}
		// Cache is keyed by frameId → invalidate to ensure future frameForId resolves with latest owner
		this.frameCache.delete(frameId)
	}

	/**
	 * Parent/child session emitted a `frameDetached`.
	 */
	public onFrameDetached(
		frameId: string,
		reason: "remove" | "swap" | string = "remove",
	): string[] {
		// The registry prunes the whole subtree; mirror that in the Page caches.
		const removed = this.registry.onFrameDetached(frameId, reason)
		this.frameCache.delete(frameId)
		for (const fid of removed) {
			this.frameCache.delete(fid)
			this.frameOrdinals.delete(fid)
		}
		return removed
	}

	/**
	 * Parent/child session emitted a `frameNavigated`.
	 * Topology + ownership update. Handles root swaps.
	 */
	public onFrameNavigated(
		frame: Protocol.Page.Frame,
		session: CDPSessionLike,
	): void {
		const prevRoot = this.mainFrameId()
		this.registry.onFrameNavigated(frame, session.id ?? "root")

		// If the root changed, keep the convenience wrapper in sync
		const newRoot = this.mainFrameId()
		if (newRoot !== prevRoot) {
			const oldOrd = this.frameOrdinals.get(prevRoot) ?? 0
			this.frameOrdinals.delete(prevRoot)
			this.frameCache.delete(prevRoot)
			this.frameOrdinals.set(newRoot, oldOrd)
			this.mainFrameWrapper = new Frame(
				this.mainSession,
				newRoot,
				this.pageId,
				false,
				this.logger,
				this.disposeController.signal,
			)
		}

		// Update cached URL if this navigation pertains to the current main frame
		if (frame.id === this.mainFrameId()) {
			this.mainFrameNavigationVersion += 1
			try {
				this._currentUrl = String(
					(frame as { url?: string })?.url ?? this._currentUrl,
				)
			} catch {}
		}

		// Invalidate the cached Frame for this id (session may have changed)
		this.frameCache.delete(frame.id)
	}

	public onNavigatedWithinDocument(
		frameId: string,
		url: string,
		session: CDPSessionLike,
	): void {
		const normalized = String(url ?? "").trim()
		if (!normalized) {
			return
		}

		this.registry.onNavigatedWithinDocument(
			frameId,
			normalized,
			session.id ?? "root",
		)

		if (frameId === this.mainFrameId()) {
			this.mainFrameNavigationVersion += 1
			this._currentUrl = normalized
		}
	}

	/**
	 * An OOPIF child session whose **main** frame id equals the parent iframe’s frameId
	 * has been attached; adopt the session into this Page and seed ownership for its subtree.
	 */
	public adoptOopifSession(
		childSession: CDPSessionLike,
		childMainFrameId: string,
	): void {
		if (this.disposed) {
			return
		}
		const previousOwnerSessionId =
			this.registry.getOwnerSessionId(childMainFrameId)
		const childSessionId = childSession.id ?? "child"
		if (childSession.id) {
			this.sessions.set(childSession.id, childSession)
		}

		try {
			this.networkManager.trackSession(childSession)
			this.installConsoleTap(childSession)
		} catch (error) {
			this.teardownConsoleTap(childSessionId)
			this.networkManager.untrackSession(childSession.id ?? undefined)
			if (childSession.id) {
				this.sessions.delete(childSession.id)
			}
			throw error
		}
		if (this.extraHTTPHeaders) {
			void this.applyExtraHTTPHeadersToSession(
				childSession,
				this.extraHTTPHeaders,
			).catch(() => {})
		}

		void this.applyInitScriptsToSession(childSession).catch(() => {})

		// session will start emitting its own page events; mark ownership seed now
		this.registry.adoptChildSession(childSessionId, childMainFrameId)
		this.frameCache.delete(childMainFrameId)

		// One-shot seed the child's subtree ownership from its current tree
		void (async () => {
			try {
				await childSession.send("Page.enable").catch(() => {})
				let { frameTree } = await childSession.send("Page.getFrameTree")

				// Normalize: ensure the child’s reported root id matches our known main id
				if (frameTree.frame.id !== childMainFrameId) {
					frameTree = {
						...frameTree,
						frame: { ...frameTree.frame, id: childMainFrameId },
					}
				}

				if (this.disposed) {
					return
				}
				if (
					childSession.id &&
					this.sessions.get(childSession.id) !== childSession
				) {
					return
				}
				if (
					this.registry.getOwnerSessionId(childMainFrameId) !== childSessionId
				) {
					return
				}
				this.registry.seedFromFrameTree(childSessionId, frameTree, {
					preserveRootParent: true,
					replaceOwnerSessionId: previousOwnerSessionId,
				})
			} catch {
				// If snapshot races, live events will still converge the registry.
			}
		})()
	}

	/** Detach an adopted child session and prune its subtree */
	public detachOopifSession(sessionId: string): string[] {
		const removedFrameIds = new Set<string>()
		// Find which frames were owned by this session and prune by tree starting from each root.
		for (const fid of this.registry.framesForSession(sessionId)) {
			const removed = this.registry.onFrameDetached(fid, "remove")
			this.frameCache.delete(fid)
			for (const removedId of removed) {
				removedFrameIds.add(removedId)
				this.frameCache.delete(removedId)
				this.frameOrdinals.delete(removedId)
			}
		}
		this.teardownConsoleTap(sessionId)
		this.sessions.delete(sessionId)
		this.networkManager.untrackSession(sessionId)
		return [...removedFrameIds]
	}

	// ---------------- Ownership helpers / lookups ----------------

	/** Return the owning CDP session for a frameId (falls back to main session) */
	public getSessionForFrame(frameId: string): CDPSessionLike {
		const sid = this.registry.getOwnerSessionId(frameId)
		if (!sid) {
			return this.mainSession
		}
		return this.sessions.get(sid) ?? this.mainSession
	}

	/** Always returns a Frame bound to the owning session */
	public frameForId(frameId: string): Frame {
		const hit = this.frameCache.get(frameId)
		if (hit) {
			return hit
		}

		const sess = this.getSessionForFrame(frameId)
		const f = new Frame(
			sess,
			frameId,
			this.pageId,
			false,
			this.logger,
			this.disposeController.signal,
		)
		this.frameCache.set(frameId, f)
		return f
	}

	/** Expose a session by id (used by snapshot to resolve session id -> session) */
	public getSessionById(id: string): CDPSessionLike | undefined {
		return this.sessions.get(id)
	}

	public registerSessionForNetwork(session: CDPSessionLike): void {
		this.networkManager.trackSession(session)
	}

	public unregisterSessionForNetwork(sessionId: string | undefined): void {
		this.networkManager.untrackSession(sessionId)
	}

	public on(event: "console", listener: ConsoleListener): Page {
		this.assertOpen()
		if (event !== "console") {
			throw new HandstageInvalidArgumentError(`Unsupported event: ${event}`)
		}

		this.consoleListeners.add(listener)
		this.ensureConsoleTaps()

		return this
	}

	public once(event: "console", listener: ConsoleListener): Page {
		if (event !== "console") {
			throw new HandstageInvalidArgumentError(`Unsupported event: ${event}`)
		}

		const wrapper: ConsoleListener = (message) => {
			this.off("console", wrapper)
			listener(message)
		}

		return this.on("console", wrapper)
	}

	public off(event: "console", listener: ConsoleListener): Page {
		if (event !== "console") {
			throw new HandstageInvalidArgumentError(`Unsupported event: ${event}`)
		}

		this.consoleListeners.delete(listener)

		return this
	}

	// ---------------- MAIN APIs ----------------

	public targetId(): string {
		return this._targetId
	}

	/** @internal */
	public isDisposed(): boolean {
		return this.disposed
	}

	/** @internal */
	public disposalSignal(): AbortSignal {
		return this.disposeController.signal
	}

	/** @internal */
	public registerOnCloseCallback(callback: () => void): void {
		this.closeCallbacks.add(callback)
	}

	/**
	 * Bring this page's tab to the foreground in the browser.
	 *
	 * Wraps `Target.activateTarget`.  In headless Chrome this is a no-op for
	 * end users but still required so dispatchKeyEvent / dispatchMouseEvent
	 * land on the intended target.  Use this in place of any "active page"
	 * concept on the context — callers track Page references explicitly and
	 * decide which one is foreground.
	 */
	public async bringToFront(): Promise<void> {
		await this.conn
			.send("Target.activateTarget", { targetId: this._targetId })
			.catch(() => {})
	}

	/**
	 * Send a CDP command through the main session.
	 * Allows external consumers to execute arbitrary Chrome DevTools Protocol commands.
	 *
	 * @param method - The typed CDP method name (e.g., "Page.enable", "Runtime.evaluate")
	 * @param params - Parameters required by the selected CDP command
	 * @returns Promise resolving to the protocol response for the selected method
	 *
	 * @example
	 * // Enable the Runtime domain
	 * await page.sendCDP("Runtime.enable");
	 *
	 * @example
	 * // Evaluate JavaScript with the response inferred from "Runtime.evaluate"
	 * const result = await page.sendCDP("Runtime.evaluate", { expression: "1 + 1" });
	 */
	public sendCDP<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		this.assertOpen()
		return this.mainSession.send(method, ...params)
	}

	/** Seed the cached URL before navigation events converge. */
	public seedCurrentUrl(url: string | undefined | null): void {
		if (!url) {
			return
		}
		try {
			const normalized = String(url).trim()
			if (!normalized) {
				return
			}
			this._currentUrl = normalized
		} catch {}
	}

	/** @internal Start Context.newPage(url)'s non-blocking first navigation. */
	public startInitialNavigation(url: string): void {
		this.assertOpen()
		if (this.pendingInitialNavigation) {
			this.finishInitialNavigation(this.pendingInitialNavigation)
		}
		let resolveSettled = () => {}
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve
		})
		const state: InitialNavigationState = {
			settled,
			resolveSettled,
			superseded: false,
			finished: false,
		}
		this.pendingInitialNavigation = state

		let command: Promise<CDPCommandResult<"Page.navigate">>
		try {
			command = this.mainSession.send("Page.navigate", { url })
		} catch {
			this.finishInitialNavigation(state)
			return
		}
		void command.then(
			(response) => {
				if (state.finished) {
					return
				}
				if (response.loaderId) {
					if (state.superseded) {
						this.rememberSupersededNavigationLoader(response.loaderId)
					} else {
						this.initialNavigationLoaderId = response.loaderId
					}
				}
				this.finishInitialNavigation(state)
			},
			() => {
				if (!state.finished) {
					this.finishInitialNavigation(state)
				}
			},
		)
	}

	public mainFrameId(): string {
		return this.registry.mainFrameId()
	}

	/** @internal Current loader recorded for the main frame, when known. */
	public mainFrameLoaderId(): string | undefined {
		try {
			return this.registry.asProtocolFrameTree(this.mainFrameId()).frame
				.loaderId
		} catch {
			return undefined
		}
	}

	public mainFrame(): Frame {
		return this.mainFrameWrapper
	}

	/** Close this top-level page and confirm that its target is gone. */
	public async close(): Promise<void> {
		if (this.disposed) {
			return
		}
		if (this.closePromise) {
			return this.closePromise
		}
		this.closing = true
		const operation = (async () => {
			try {
				await closeTargetAndConfirm(this.conn, this._targetId, {
					operation: "page.close",
				})
			} catch (error) {
				if (!this.disposed) {
					throw error
				}
			}
			if (this.disposed) {
				return
			}
			const callbacks = [...this.closeCallbacks]
			this.closeCallbacks.clear()
			for (const callback of callbacks) {
				try {
					callback()
				} catch {}
			}
			this.disposeResources()
		})()
		this.closePromise = operation
		try {
			await operation
		} catch (error) {
			if (!this.disposed) {
				this.closing = false
				this.closePromise = null
			}
			throw error
		}
	}

	public disposeResources(): void {
		if (this.disposed) {
			return
		}
		this.disposed = true
		if (this.pendingInitialNavigation) {
			this.finishInitialNavigation(this.pendingInitialNavigation)
		}
		this.closing = false
		this.disposeController.abort(
			new CDPConnectionClosedError("page is disposed"),
		)
		this.activeNavigationController?.abort(
			new CDPConnectionClosedError("page is disposed"),
		)
		this.activeNavigationController = null
		this.pendingNavigationReservation?.controller.abort(
			new CDPConnectionClosedError("page is disposed"),
		)
		this.pendingNavigationReservation = null
		this.initialNavigationLoaderId = null
		this.activeNavigationLoaderIds.clear()
		this.supersededNavigationLoaderIds.clear()
		for (const cleanup of [...this.activeLifecycleWaitCleanups]) {
			try {
				cleanup(new CDPConnectionClosedError("page is disposed"))
			} catch {}
		}
		try {
			this.networkManager.dispose()
		} catch {}
		try {
			this.removeAllConsoleTaps()
		} catch {}
		this.consoleListeners.clear()
		this.sessions.clear()
		this.consoleHandlers.clear()
		this.frameCache.clear()
		this.frameOrdinals.clear()
		this.initScripts.length = 0
		this.extraHTTPHeaders = {}
		this.keyboard.reset()
		this.mouse.reset()
		this.closeCallbacks.clear()
		this.registry.clear()
	}

	public getFullFrameTree(): Protocol.Page.FrameTree {
		return this.asProtocolFrameTree(this.mainFrameId())
	}

	public asProtocolFrameTree(rootMainFrameId: string): Protocol.Page.FrameTree {
		return this.registry.asProtocolFrameTree(rootMainFrameId)
	}

	private async applyExtraHTTPHeadersToSession(
		session: CDPSessionLike,
		headers: Record<string, string>,
	): Promise<void> {
		await session.send("Network.enable")
		await session.send("Network.setExtraHTTPHeaders", {
			headers: headers,
		})
	}

	private ensureOrdinal(frameId: string): number {
		const hit = this.frameOrdinals.get(frameId)
		if (hit !== undefined) {
			return hit
		}
		const ord = this.nextOrdinal++
		this.frameOrdinals.set(frameId, ord)
		return ord
	}

	/** Public getter for snapshot code / handlers. */
	public getOrdinal(frameId: string): number {
		return this.ensureOrdinal(frameId)
	}

	public listAllFrameIds(): string[] {
		return this.registry.listAllFrames()
	}

	private ensureConsoleTaps(): void {
		this.installConsoleTap(this.mainSession)
		for (const session of this.sessions.values()) {
			this.installConsoleTap(session)
		}
	}

	private installConsoleTap(session: CDPSessionLike): void {
		const key = this.sessionKey(session)
		if (this.consoleHandlers.has(key)) {
			return
		}

		try {
			void session.send("Runtime.enable").catch(() => {})
		} catch {}

		const handler = (evt: Protocol.Runtime.ConsoleAPICalledEvent) => {
			this.emitConsole(evt, session)
		}

		session.on("Runtime.consoleAPICalled", handler)

		this.consoleHandlers.set(key, handler)
	}

	private sessionKey(session: CDPSessionLike): string {
		return session.id ?? "__root__"
	}

	private resolveSessionByKey(key: string): CDPSessionLike | undefined {
		if (this.mainSession.id) {
			if (this.mainSession.id === key) {
				return this.mainSession
			}
		} else if (key === "__root__") {
			return this.mainSession
		}

		return this.sessions.get(key)
	}

	private teardownConsoleTap(key: string): void {
		const handler = this.consoleHandlers.get(key)
		if (!handler) {
			return
		}

		const session = this.resolveSessionByKey(key)
		try {
			session?.off("Runtime.consoleAPICalled", handler)
		} catch {
		} finally {
			this.consoleHandlers.delete(key)
		}
	}

	private removeAllConsoleTaps(): void {
		for (const key of [...this.consoleHandlers.keys()]) {
			this.teardownConsoleTap(key)
		}
	}

	private emitConsole(
		evt: Protocol.Runtime.ConsoleAPICalledEvent,
		session: CDPSessionLike,
	): void {
		const message = new ConsoleMessage(evt, this)
		const listeners = [...this.consoleListeners]

		try {
			for (const listener of listeners) {
				try {
					listener(message)
				} catch (error) {
					try {
						this.logger({
							category: "page",
							message: "Console listener threw",
							level: LogLevel.Debug,
							attributes: {
								error: String(error),
								type: evt.type,
							},
						})
					} catch {}
				}
			}
		} finally {
			void releaseObjectIds(session, evt.args?.map((arg) => arg.objectId) ?? [])
		}
	}

	// -------- Convenience APIs delegated to the current main frame --------

	/**
	 * Navigate the page; optionally wait for a lifecycle state.
	 * Waits on the **current** main frame and follows root swaps during navigation.
	 */
	async goto(
		url: string,
		options?: { waitUntil?: LoadState; timeoutMs?: number },
	): Promise<Response | null> {
		this.assertOpen()
		const waitUntil: LoadState = options?.waitUntil ?? "domcontentloaded"
		const timeout = options?.timeoutMs ?? 15000
		const navigationVersion = this.mainFrameNavigationVersion
		const navigation = this.beginNavigationCommand()
		const deadline = createDeadlineSignal(
			AbortSignal.any([this.disposeController.signal, navigation.signal]),
			"goto",
			timeout,
		)

		const tracker = new NavigationResponseTracker({
			page: this,
			session: this.mainSession,
			connection: this.conn,
			navigationCommandId: navigation.id,
		})

		const watcher = new LifecycleWatcher({
			page: this,
			mainSession: this.mainSession,
			networkManager: this.networkManager,
			waitUntil,
			timeoutMs: timeout,
			navigationCommandId: navigation.id,
			signal: deadline.signal,
			onLoaderIdChanged: (loaderId) => {
				this.observeNavigationLoader(navigation.id, loaderId)
				tracker.setExpectedLoaderId(loaderId)
			},
		})

		try {
			const response = await sendCDPWithSignal(
				this.mainSession,
				"Page.navigate",
				deadline.signal,
				{ url },
			)
			deadline.signal.throwIfAborted()
			if (response.errorText) {
				throw new Error(`Navigation failed: ${response.errorText}`)
			}
			if (this.mainFrameNavigationVersion === navigationVersion) {
				this._currentUrl = url
			}
			if (response?.loaderId) {
				watcher.setExpectedLoaderId(response.loaderId)
			} else {
				watcher.allowCurrentDocument()
			}
			await watcher.wait()
			return await tracker.navigationCompleted()
		} finally {
			watcher.dispose()
			tracker.dispose()
			deadline.dispose()
		}
	}

	/**
	 * Reload the page; optionally wait for a lifecycle state.
	 */
	async reload(options?: {
		waitUntil?: LoadState
		timeoutMs?: number
		ignoreCache?: boolean
	}): Promise<Response | null> {
		this.assertOpen()
		const waitUntil = options?.waitUntil
		const timeout = options?.timeoutMs ?? 15000
		const navigation = this.beginNavigationCommand()
		const deadline = createDeadlineSignal(
			AbortSignal.any([this.disposeController.signal, navigation.signal]),
			"reload",
			timeout,
		)

		const tracker = new NavigationResponseTracker({
			page: this,
			session: this.mainSession,
			connection: this.conn,
			navigationCommandId: navigation.id,
		})
		tracker.expectNavigationWithoutKnownLoader()

		const watcher = waitUntil
			? new LifecycleWatcher({
					page: this,
					mainSession: this.mainSession,
					networkManager: this.networkManager,
					waitUntil,
					timeoutMs: timeout,
					navigationCommandId: navigation.id,
					signal: deadline.signal,
					onLoaderIdChanged: (loaderId) => {
						this.observeNavigationLoader(navigation.id, loaderId)
						tracker.setExpectedLoaderId(loaderId)
					},
				})
			: null
		watcher?.expectNavigationWithoutKnownLoader()

		try {
			await sendCDPWithSignal(
				this.mainSession,
				"Page.reload",
				deadline.signal,
				{ ignoreCache: options?.ignoreCache ?? false },
			)
			deadline.signal.throwIfAborted()

			if (watcher) {
				await watcher.wait()
			}
			return await tracker.navigationCompleted()
		} finally {
			watcher?.dispose()
			tracker.dispose()
			deadline.dispose()
		}
	}

	/**
	 * Navigate back in history if possible; optionally wait for a lifecycle state.
	 */
	async goBack(options?: {
		waitUntil?: LoadState
		timeoutMs?: number
	}): Promise<Response | null> {
		return this.navigateHistory(-1, "goBack", options)
	}

	/**
	 * Navigate forward in history if possible; optionally wait for a lifecycle state.
	 */
	async goForward(options?: {
		waitUntil?: LoadState
		timeoutMs?: number
	}): Promise<Response | null> {
		return this.navigateHistory(1, "goForward", options)
	}

	private async navigateHistory(
		delta: -1 | 1,
		operation: "goBack" | "goForward",
		options?: { waitUntil?: LoadState; timeoutMs?: number },
	): Promise<Response | null> {
		this.assertOpen()
		const timeout = options?.timeoutMs ?? 15000
		const reservation = this.reserveNavigationCommand()
		const deadline = createDeadlineSignal(
			AbortSignal.any([this.disposeController.signal, reservation.signal]),
			operation,
			timeout,
		)
		let activated = false
		try {
			const { entries, currentIndex } = await sendCDPWithSignal(
				this.mainSession,
				"Page.getNavigationHistory",
				deadline.signal,
			)
			deadline.signal.throwIfAborted()
			const entry = entries[currentIndex + delta]
			if (!entry) {
				return null
			}
			const navigation = this.activateNavigationCommand(reservation)
			activated = true
			const navigationSignal = AbortSignal.any([
				deadline.signal,
				navigation.signal,
			])
			const tracker = new NavigationResponseTracker({
				page: this,
				session: this.mainSession,
				connection: this.conn,
				navigationCommandId: navigation.id,
			})
			tracker.expectNavigationWithoutKnownLoader()
			const waitUntil = options?.waitUntil
			const watcher = waitUntil
				? new LifecycleWatcher({
						page: this,
						mainSession: this.mainSession,
						networkManager: this.networkManager,
						waitUntil,
						timeoutMs: timeout,
						navigationCommandId: navigation.id,
						signal: navigationSignal,
						onLoaderIdChanged: (loaderId) => {
							this.observeNavigationLoader(navigation.id, loaderId)
							tracker.setExpectedLoaderId(loaderId)
						},
					})
				: null
			watcher?.expectNavigationWithoutKnownLoader()
			try {
				await sendCDPWithSignal(
					this.mainSession,
					"Page.navigateToHistoryEntry",
					navigationSignal,
					{ entryId: entry.id },
				)
				navigationSignal.throwIfAborted()
				this._currentUrl = entry.url ?? this._currentUrl
				if (watcher) {
					await watcher.wait()
				}
				return await tracker.navigationCompleted()
			} finally {
				watcher?.dispose()
				tracker.dispose()
			}
		} finally {
			if (!activated) {
				this.releaseNavigationReservation(reservation)
			}
			deadline.dispose()
		}
	}

	/**
	 * Return the current page URL (synchronous, cached from navigation events).
	 */
	url(): string {
		return this._currentUrl
	}

	private reserveNavigationCommand(): NavigationReservation {
		this.assertOpen()
		const id = ++this.navigationCommandSeq
		const previous = this.pendingNavigationReservation
		const controller = new AbortController()
		this.pendingNavigationReservation = { id, controller }
		previous?.controller.abort(
			new Error("Navigation was superseded by a new request"),
		)
		return { id, signal: controller.signal }
	}

	private releaseNavigationReservation(
		reservation: NavigationReservation,
	): void {
		if (this.pendingNavigationReservation?.id === reservation.id) {
			this.pendingNavigationReservation = null
		}
	}

	private activateNavigationCommand(
		reservation: NavigationReservation,
	): NavigationReservation {
		if (
			reservation.signal.aborted ||
			this.pendingNavigationReservation?.id !== reservation.id
		) {
			throw reservation.signal.reason instanceof Error
				? reservation.signal.reason
				: new Error("Navigation was superseded by a new request")
		}
		this.pendingNavigationReservation = null
		if (this.pendingInitialNavigation) {
			this.pendingInitialNavigation.superseded = true
		}
		if (this.initialNavigationLoaderId) {
			this.rememberSupersededNavigationLoader(this.initialNavigationLoaderId)
			this.initialNavigationLoaderId = null
		}
		for (const loaderId of this.activeNavigationLoaderIds) {
			this.rememberSupersededNavigationLoader(loaderId)
		}
		this.activeNavigationLoaderIds.clear()
		this.latestNavigationCommandId = reservation.id
		const previous = this.activeNavigationController
		const controller = new AbortController()
		this.activeNavigationController = controller
		previous?.abort(new Error("Navigation was superseded by a new request"))
		return { id: reservation.id, signal: controller.signal }
	}

	private beginNavigationCommand(): NavigationReservation {
		return this.activateNavigationCommand(this.reserveNavigationCommand())
	}

	public isCurrentNavigationCommand(id: number): boolean {
		return this.latestNavigationCommandId === id
	}

	public isSupersededNavigationLoader(loaderId: string): boolean {
		return this.supersededNavigationLoaderIds.has(loaderId)
	}

	public pendingSupersededNavigation(): Promise<void> | null {
		const state = this.pendingInitialNavigation
		return state?.superseded ? state.settled : null
	}

	private observeNavigationLoader(commandId: number, loaderId: string): void {
		if (!loaderId || !this.isCurrentNavigationCommand(commandId)) {
			return
		}
		this.activeNavigationLoaderIds.add(loaderId)
	}

	private rememberSupersededNavigationLoader(loaderId: string): void {
		this.supersededNavigationLoaderIds.delete(loaderId)
		this.supersededNavigationLoaderIds.add(loaderId)
		while (this.supersededNavigationLoaderIds.size > 128) {
			const oldest = this.supersededNavigationLoaderIds.values().next()
			if (oldest.done) {
				break
			}
			this.supersededNavigationLoaderIds.delete(oldest.value)
		}
	}

	private finishInitialNavigation(state: InitialNavigationState): void {
		if (state.finished) {
			return
		}
		state.finished = true
		if (this.pendingInitialNavigation === state) {
			this.pendingInitialNavigation = null
		}
		state.resolveSettled()
	}

	/**
	 * Return the current page title.
	 * Prefers reading from the active document via Runtime.evaluate to reflect dynamic changes.
	 * Falls back to navigation history title if evaluation is unavailable.
	 */
	async title(): Promise<string> {
		this.assertOpen()
		const signal = this.disposeController.signal
		try {
			await sendCDPWithSignal(this.mainSession, "Runtime.enable", signal)
			const response = await this.evaluateMainWorldProbe(
				"document.title",
				signal,
			)
			const value = response.exceptionDetails
				? null
				: String(response.result.value ?? "")
			if (value === null) {
				throw new Error("Unable to evaluate document.title")
			}
			return value
		} catch (error) {
			if (signal.aborted) {
				throw error
			}
			// Fallback: use navigation history entry title
			try {
				const { entries, currentIndex } = await sendCDPWithSignal(
					this.mainSession,
					"Page.getNavigationHistory",
					signal,
				)
				return entries[currentIndex]?.title ?? ""
			} catch (fallbackError) {
				if (signal.aborted) {
					throw fallbackError
				}
				return ""
			}
		}
	}

	/**
	 * Capture a screenshot with Playwright-style options.
	 *
	 * @param options Optional screenshot configuration.
	 * @param options.animations Control CSS/Web animations during capture. Use
	 * "disabled" to fast-forward finite animations and pause infinite ones.
	 * @param options.caret Either hide the text caret (default) or leave it
	 * visible via "initial".
	 * @param options.clip Restrict capture to a specific rectangle (in CSS
	 * pixels). Cannot be combined with `fullPage`.
	 * @param options.fullPage Capture the full scrollable page instead of the
	 * current viewport.
	 * @param options.mask Array of locators that should be covered with an
	 * overlay while the screenshot is taken.
	 * @param options.maskColor CSS color used for the mask overlay (default
	 * `#FF00FF`).
	 * @param options.omitBackground Make the default page background transparent
	 * (PNG only).
	 * @param options.path File path to write the screenshot to. The file extension
	 * determines the image type when `type` is not explicitly provided.
	 * @param options.quality JPEG quality (0–100). Only applies when
	 * `type === "jpeg"`.
	 * @param options.scale Render scale: use "css" for one pixel per CSS pixel,
	 * otherwise the default "device" leverages the current device pixel ratio.
	 * @param options.style Additional CSS text injected into every frame before
	 * capture (removed afterwards).
	 * @param options.timeout Maximum capture duration in milliseconds before a
	 * timeout error is thrown.
	 * @param options.type Image format (`"png"` by default).
	 */
	async screenshot(options?: ScreenshotOptions): Promise<Uint8Array> {
		this.assertOpen()
		const opts = options ?? {}
		const type = opts.type ?? "png"

		if (type !== "png" && type !== "jpeg") {
			throw new HandstageInvalidArgumentError(
				`screenshot: unsupported image type "${type}"`,
			)
		}

		if (opts.fullPage && opts.clip) {
			throw new HandstageInvalidArgumentError(
				"screenshot: clip and fullPage cannot be used together",
			)
		}

		if (type === "png" && typeof opts.quality === "number") {
			throw new HandstageInvalidArgumentError(
				'screenshot: quality option is only valid for type="jpeg"',
			)
		}

		const caretMode: ScreenshotCaretOption = opts.caret ?? "hide"
		const animationsMode: ScreenshotAnimationsOption =
			opts.animations ?? "allow"
		const scaleMode: ScreenshotScaleOption = opts.scale ?? "device"
		const cleanupScope = new ScreenshotCleanupScope(
			this.disposeController.signal,
			opts.timeout,
		)
		const operationSignal = cleanupScope.signal

		try {
			operationSignal.throwIfAborted()
			const frames = collectFramesForScreenshot(this)
			const clip = opts.clip ? normalizeScreenshotClip(opts.clip) : undefined
			const captureScale = await computeScreenshotScale(
				this,
				scaleMode,
				operationSignal,
			)
			const maskLocators = (opts.mask ?? []).filter(
				(locator): locator is Locator => Boolean(locator),
			)
			if (opts.omitBackground) {
				await cleanupScope.install(
					setTransparentBackground(this.mainSession, operationSignal),
				)
			}

			if (animationsMode === "disabled") {
				await cleanupScope.install(disableAnimations(frames, operationSignal))
			}

			if (caretMode === "hide") {
				await cleanupScope.install(hideCaret(frames, operationSignal))
			}

			if (opts.style?.trim()) {
				await cleanupScope.install(
					applyStyleToFrames(frames, opts.style, "custom", operationSignal),
				)
			}

			if (maskLocators.length > 0) {
				await cleanupScope.install(
					applyMaskOverlays(
						maskLocators,
						opts.maskColor ?? "#FF00FF",
						operationSignal,
					),
				)
			}

			operationSignal.throwIfAborted()
			const buffer = await this.mainFrameWrapper.screenshot({
				fullPage: opts.fullPage,
				clip,
				type,
				quality: type === "jpeg" ? opts.quality : undefined,
				scale: captureScale,
				signal: operationSignal,
			})

			if (opts.path) {
				operationSignal.throwIfAborted()
				await fs.writeFile(opts.path, buffer, {
					signal: operationSignal,
				})
				operationSignal.throwIfAborted()
			}

			return buffer
		} finally {
			try {
				await cleanupScope.close()
			} finally {
				cleanupScope.dispose()
			}
		}
	}

	/**
	 * specifies additional HTTP headers to be included in every request sent by
	 * the root CDP session of the page, and all of its child CDP sessions.
	 *
	 * @param headers - the headers to be set.
	 * @throws {HandstageSetExtraHTTPHeadersError}
	 * Thrown when one or more CDP sessions fail to enable the Network domain or fail
	 * to apply the headers (i.e. `Network.enable` and/or `Network.setExtraHTTPHeaders` rejects).
	 * @return void
	 */
	async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
		this.assertOpen()
		const headersToSet = { ...headers }
		this.extraHTTPHeaders = headersToSet

		// get the session(s) for this page:
		const sessions: CDPSessionLike[] = [this.mainSession]
		for (const session of this.sessions.values()) {
			if (session === this.mainSession) {
				continue
			}
			sessions.push(session)
		}

		const results = await Promise.allSettled(
			sessions.map(async (session) => {
				await this.applyExtraHTTPHeadersToSession(session, headersToSet)
			}),
		)

		// get list of objects containing results & corresponding session IDs
		const pairs = results.map((result, index) => {
			const session = sessions[index]
			if (!session) {
				throw new HandstageSetExtraHTTPHeadersError([
					`missing CDP session for result index ${index}`,
				])
			}
			return {
				result,
				id: session.id,
			}
		})

		const filtered = pairs.filter(
			(pair): pair is { result: PromiseRejectedResult; id: string | null } =>
				pair.result.status === "rejected",
		)

		const errors = filtered.map((pair) => {
			const reason = pair.result.reason
			const sessId = pair.id ?? "root"
			const message = errorMessage(reason)
			return `session=${sessId} error=${message}`
		})

		if (errors.length > 0) {
			throw new HandstageSetExtraHTTPHeadersError(errors)
		}
	}

	/**
	 * Create a locator bound to the current main frame.
	 */
	locator(selector: string): ReturnType<Frame["locator"]> {
		return this.mainFrameWrapper.locator(selector)
	}

	/**
	 * Deep locator that supports cross-iframe traversal.
	 * - Recognizes '>>' hop notation to enter iframe contexts.
	 * - Supports deep XPath that includes iframe steps (e.g., '/html/body/iframe[2]//div').
	 * Returns a Locator scoped to the appropriate frame.
	 */
	deepLocator(selector: string) {
		return deepLocatorFromPage(this, this.mainFrameWrapper, selector)
	}

	/**
	 * Frame locator similar to Playwright: targets iframe elements and scopes
	 * subsequent locators to that frame. Supports chaining.
	 */
	frameLocator(selector: string): FrameLocator {
		return new FrameLocator(this, selector)
	}

	/**
	 * List all frames belonging to this page as Frame objects bound to their owning sessions.
	 * The list is ordered by a stable ordinal assigned during the page lifetime.
	 */
	frames(): Frame[] {
		const ids = this.listAllFrameIds()
		const withOrd = ids.map((id) => ({ id, ord: this.getOrdinal(id) }))
		withOrd.sort((a, b) => a.ord - b.ord)
		return withOrd.map(({ id }) => this.frameForId(id))
	}

	/**
	 * Wait until the page reaches a lifecycle state on the current main frame.
	 * Mirrors Playwright's API signatures.
	 */
	async waitForLoadState(state: LoadState, timeoutMs?: number): Promise<void> {
		await this.waitForMainLoadState(state, timeoutMs ?? 15000)
	}

	/**
	 * Wait for a specified amount of time.
	 *
	 * @param ms The number of milliseconds to wait.
	 */
	async waitForTimeout(ms: number): Promise<void> {
		this.assertOpen()
		await this.delay(ms)
	}

	/**
	 * Wait for an element matching the selector to appear in the DOM.
	 * Uses MutationObserver for efficiency
	 * Pierces shadow DOM by default.
	 * Supports iframe hop notation with '>>' (e.g., 'iframe#checkout >> .submit-btn').
	 *
	 * @param selector CSS selector to wait for (supports '>>' for iframe hops)
	 * @param options
	 * @param options.state Element state to wait for: 'attached' | 'detached' | 'visible' | 'hidden' (default: 'visible')
	 * @param options.timeout Maximum time to wait in milliseconds (default: 30000)
	 * @param options.pierceShadow Whether to search inside shadow DOM (default: true)
	 * @returns True when the condition is met
	 * @throws Error if timeout is reached before the condition is met
	 */
	async waitForSelector(
		selector: string,
		options?: {
			state?: "attached" | "detached" | "visible" | "hidden"
			timeout?: number
			pierceShadow?: boolean
		},
	): Promise<boolean> {
		const timeout = options?.timeout ?? 30000
		const state = options?.state ?? "visible"
		const pierceShadow = options?.pierceShadow ?? true
		const startTime = Date.now()
		const root = this.mainFrameWrapper
		const { frame: targetFrame, selector: finalSelector } =
			await resolveLocatorTarget(this, root, selector)
		const elapsed = Date.now() - startTime
		const remainingTimeout = Math.max(0, timeout - elapsed)

		const expression = buildLocatorInvocation("waitForSelector", [
			JSON.stringify(finalSelector),
			JSON.stringify(state),
			String(remainingTimeout),
			String(pierceShadow),
		])
		return targetFrame.evaluate(expression)
	}

	/**
	 * Evaluate a function or expression in the current main frame's main world.
	 * - If a string is provided, it is treated as a JS expression.
	 * - If a function is provided, it is stringified and invoked with the optional argument.
	 * - The return value should be JSON-serializable. Non-serializable objects will
	 *   best-effort serialize via JSON.stringify inside the page context.
	 */
	async evaluate<R = unknown, Arg = unknown>(
		pageFunctionOrExpression: string | ((arg: Arg) => R | Promise<R>),
		arg?: Arg,
	): Promise<R> {
		this.assertOpen()
		return this.mainFrameWrapper.evaluate(
			pageFunctionOrExpression,
			arg,
			this.disposeController.signal,
		)
	}

	/**
	 * Force the page viewport to an exact CSS size and device scale factor.
	 * Ensures screenshots match width x height pixels when deviceScaleFactor = 1.
	 */
	async setViewportSize(
		width: number,
		height: number,
		options?: { deviceScaleFactor?: number; signal?: AbortSignal },
	): Promise<void> {
		this.assertOpen()
		const dsf = Math.max(0.01, options?.deviceScaleFactor ?? 1)
		const operationSignal = options?.signal
			? AbortSignal.any([this.disposeController.signal, options.signal])
			: this.disposeController.signal
		const send = <M extends CDPCommand>(
			method: M,
			...params: CDPCommandParams<M>
		) => sendCDPWithSignal(this.mainSession, method, operationSignal, ...params)
		const sendBestEffort = async <M extends CDPCommand>(
			method: M,
			...params: CDPCommandParams<M>
		): Promise<void> => {
			try {
				await send(method, ...params)
			} catch (error) {
				if (operationSignal.aborted) {
					throw error
				}
			}
		}
		await sendBestEffort("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			deviceScaleFactor: dsf,
			mobile: false,
			screenWidth: width,
			screenHeight: height,
			positionX: 0,
			positionY: 0,
			scale: 1,
		})

		// Best-effort ensure visible size in headless
		await sendBestEffort("Emulation.setVisibleSize", { width, height })
	}

	/**
	 * Click at absolute page coordinates (CSS pixels).
	 * Dispatches mouseMoved → mousePressed → mouseReleased via CDP Input domain
	 * on the top-level page target's session. Coordinates are relative to the
	 * viewport origin (top-left). Does not scroll.
	 */
	async click(
		x: number,
		y: number,
		options?: {
			button?: "left" | "right" | "middle"
			clickCount?: number
			returnXpath?: boolean
		},
	): Promise<string> {
		this.assertOpen()
		return this.mouse.click(x, y, options)
	}

	/**
	 * Hover at absolute page coordinates (CSS pixels).
	 * Dispatches mouseMoved via CDP Input domain on the top-level page target's
	 * session.
	 */
	async hover(
		x: number,
		y: number,
		options?: { returnXpath?: boolean },
	): Promise<string> {
		this.assertOpen()
		return this.mouse.hover(x, y, options)
	}

	async scroll(
		x: number,
		y: number,
		deltaX: number,
		deltaY: number,
		options?: { returnXpath?: boolean },
	): Promise<string> {
		this.assertOpen()
		return this.mouse.scroll(x, y, deltaX, deltaY, options)
	}

	/**
	 * Drag from (fromX, fromY) to (toX, toY) using mouse events.
	 * Sends mouseMoved → mousePressed → mouseMoved (steps) → mouseReleased.
	 */
	async dragAndDrop(
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		options?: {
			button?: "left" | "right" | "middle"
			steps?: number
			delay?: number
			returnXpath?: boolean
		},
	): Promise<[string, string]> {
		this.assertOpen()
		return this.mouse.dragAndDrop(fromX, fromY, toX, toY, options)
	}

	/**
	 * Type a string by dispatching keyDown/keyUp events per character.
	 * Focus must already be on the desired element. Uses CDP Input.dispatchKeyEvent
	 * and never falls back to Input.insertText. Optional delay applies between
	 * successive characters.
	 */
	async type(
		text: string,
		options?: { delay?: number; withMistakes?: boolean },
	): Promise<void> {
		this.assertOpen()
		await this.keyboard.typeText(text, options)
	}

	/**
	 * Press a single key or key combination (keyDown then keyUp).
	 * For printable characters, uses the text path on keyDown; for named keys, sets key/code/VK.
	 * Supports key combinations with modifiers like "Cmd+A", "Ctrl+C", "Shift+Tab", etc.
	 */
	async keyPress(key: string, options?: { delay?: number }): Promise<void> {
		this.assertOpen()
		await this.keyboard.press(key, options)
	}

	async snapshot(options?: PageSnapshotOptions): Promise<SnapshotResult> {
		try {
			const { combinedTree, combinedXpathMap, combinedUrlMap } =
				await captureHybridSnapshot(this, {
					pierceShadow: true,
					includeIframes: options?.includeIframes,
				})

			return {
				formattedTree: combinedTree,
				xpathMap: combinedXpathMap,
				urlMap: combinedUrlMap,
			}
		} catch (err) {
			throw new HandstageSnapshotError(err)
		}
	}

	// ---- Page-level lifecycle waiter that follows main frame id swaps ----

	/** Resolve the main-world execution context for the current main frame. */
	private async mainWorldExecutionContextId(
		signal?: AbortSignal,
	): Promise<number> {
		return executionContexts.waitForMainWorld(
			this.mainSession,
			this.mainFrameId(),
			1000,
			signal,
		)
	}

	private async evaluateMainWorldProbe(
		expression: string,
		signal?: AbortSignal,
	): Promise<Protocol.Runtime.EvaluateResponse> {
		signal?.throwIfAborted()
		const contextId = await this.mainWorldExecutionContextId(signal)
		signal?.throwIfAborted()
		const objectGroup = `handstage-page-probe-${++pageRuntimeProbeObjectGroupSequence}`
		try {
			const params: Protocol.Runtime.EvaluateRequest = {
				expression,
				contextId,
				returnByValue: true,
				objectGroup,
			}
			const response = signal
				? await sendCDPWithSignalAndLateResult(
						this.mainSession,
						"Runtime.evaluate",
						signal,
						() => releaseObjectGroup(this.mainSession, objectGroup),
						params,
					)
				: await this.mainSession.send("Runtime.evaluate", params)
			await releaseDiscardedEvaluationHandles(this.mainSession, response)
			signal?.throwIfAborted()
			return response
		} finally {
			await raceCleanupAgainstAbort(
				releaseObjectGroup(this.mainSession, objectGroup),
				signal,
			)
			signal?.throwIfAborted()
		}
	}

	private async isMainLoadStateReady(
		state: "domcontentloaded" | "load",
		signal?: AbortSignal,
	): Promise<boolean> {
		try {
			if (signal?.aborted) {
				throw signal.reason
			}
			const { result } = await this.evaluateMainWorldProbe(
				"document.readyState",
				signal,
			)
			const readyState = String(result?.value ?? "")
			if (state === "domcontentloaded") {
				return readyState === "interactive" || readyState === "complete"
			}
			return readyState === "complete"
		} catch (error) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new Error("Lifecycle wait aborted")
			}
			void error
			return false
		}
	}

	/**
	 * Wait until the **current** main frame reaches a lifecycle state.
	 * - Fast path via `document.readyState`.
	 * - Event path listens at the session level and compares incoming `frameId`
	 *   to `mainFrameId()` **at event time** to follow root swaps.
	 */
	async waitForMainLoadState(
		state: LoadState,
		timeoutMs = 15000,
		signal?: AbortSignal,
	): Promise<void> {
		const parentSignal = signal
			? AbortSignal.any([this.disposeController.signal, signal])
			: this.disposeController.signal
		const deadline = createDeadlineSignal(
			parentSignal,
			`waitForMainLoadState(${state})`,
			timeoutMs,
		)
		const waitSignal = deadline.signal
		const abortError = () =>
			waitSignal.reason instanceof Error
				? waitSignal.reason
				: new Error("Lifecycle wait aborted")
		const waitForState = async (): Promise<void> => {
			if (this.disposed) {
				throw new CDPConnectionClosedError("page is disposed")
			}
			if (waitSignal.aborted) {
				throw abortError()
			}

			try {
				await sendCDPWithSignal(
					this.mainSession,
					"Page.setLifecycleEventsEnabled",
					waitSignal,
					{ enabled: true },
				)
			} catch {
				if (waitSignal.aborted) {
					throw abortError()
				}
			}
			if (this.disposed) {
				throw new CDPConnectionClosedError("page is disposed")
			}
			if (waitSignal.aborted) {
				throw abortError()
			}

			if (
				(state === "domcontentloaded" || state === "load") &&
				(await this.isMainLoadStateReady(state, waitSignal))
			) {
				if (this.disposed) {
					throw new CDPConnectionClosedError("page is disposed")
				}
				if (waitSignal.aborted) {
					throw abortError()
				}
				return
			}

			const wanted = LIFECYCLE_NAME[state]
			return await new Promise<void>((resolve, reject) => {
				let done = false
				let pollTimer: ReturnType<typeof setTimeout> | null = null
				let pollInFlight = false

				const cleanup = () => {
					if (pollTimer) {
						clearTimeout(pollTimer)
						pollTimer = null
					}
					this.mainSession.off("Page.lifecycleEvent", onLifecycle)
					this.mainSession.off("Page.domContentEventFired", onDomContent)
					this.mainSession.off("Page.loadEventFired", onLoad)
					waitSignal.removeEventListener("abort", onAbort)
					this.activeLifecycleWaitCleanups.delete(fail)
				}

				const finish = () => {
					if (done) {
						return
					}
					done = true
					cleanup()
					resolve()
				}

				const fail = (error: Error) => {
					if (done) {
						return
					}
					done = true
					cleanup()
					reject(error)
				}

				const onAbort = () => fail(abortError())

				const onLifecycle = (evt: Protocol.Page.LifecycleEventEvent) => {
					if (evt.name !== wanted) {
						return
					}
					if (evt.frameId === this.mainFrameId()) {
						finish()
					}
				}

				const onDomContent = () => {
					if (state === "domcontentloaded") {
						finish()
					}
				}

				const onLoad = () => {
					if (state === "load") {
						finish()
					}
				}

				this.mainSession.on("Page.lifecycleEvent", onLifecycle)
				// Backups for sites that don't emit lifecycle consistently
				this.mainSession.on("Page.domContentEventFired", onDomContent)
				this.mainSession.on("Page.loadEventFired", onLoad)
				this.activeLifecycleWaitCleanups.add(fail)
				waitSignal.addEventListener("abort", onAbort, { once: true })
				if (waitSignal.aborted) {
					onAbort()
					return
				}

				const pollReadyState = async () => {
					if (done || pollInFlight) {
						return
					}
					pollInFlight = true
					try {
						if (done) {
							return
						}
						if (
							(state === "domcontentloaded" || state === "load") &&
							(await this.isMainLoadStateReady(state, waitSignal))
						) {
							finish()
							return
						}
					} finally {
						pollInFlight = false
					}
					if (!done) {
						pollTimer = setTimeout(() => {
							void pollReadyState().catch((error) => {
								if (!done) {
									fail(
										error instanceof Error ? error : new Error(String(error)),
									)
								}
							})
						}, 100)
					}
				}
				void pollReadyState().catch((error) => {
					if (!done) {
						fail(error instanceof Error ? error : new Error(String(error)))
					}
				})
			})
		}
		try {
			return await waitForState()
		} finally {
			deadline.dispose()
		}
	}
}
