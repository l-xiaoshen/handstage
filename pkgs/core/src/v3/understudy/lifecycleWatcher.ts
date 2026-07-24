import type { Protocol } from "devtools-protocol"
import {
	DEFAULT_IDLE_WAIT,
	IGNORED_RESOURCE_TYPES,
	type NetworkRequestInfo,
	type WaitForIdleHandle,
} from "../types/private/network"
import type { LoadState } from "../types/public/page"
import { TimeoutError } from "../types/public/sdkErrors"
import type { CDPSessionLike } from "./cdp"
import type { NetworkManager } from "./networkManager"
import type { Page } from "./page"

/**
 * Coordinates page lifecycle waits (load/domcontentloaded/networkidle) while
 * following main-frame swaps and navigation aborts. Each navigation spawns a
 * one-off watcher that listens for relevant CDP events and resolves or rejects
 * depending on the requested `waitUntil` state.
 */

/**
 * Small utility that mirrors Playwright's lifecycle watcher semantics. Bridges
 * main-frame lifecycle events with the NetworkManager's idle signal so callers
 * can await `load`, `domcontentloaded`, or `networkidle` with a single promise.
 */
export class LifecycleWatcher {
	private readonly page: Page
	private readonly mainSession: CDPSessionLike
	private readonly networkManager: NetworkManager
	private readonly waitUntil: LoadState
	private readonly timeoutMs: number
	private readonly startTime: number
	private readonly navigationCommandId: number
	private readonly onLoaderIdChanged?: (loaderId: string) => void
	private idleStartTime: number

	private cleanupCallbacks: Array<() => void> = []
	private idleHandle: WaitForIdleHandle | null = null

	private abortReject: ((error: Error) => void) | null = null
	private abortPromise: Promise<never>
	private abortError: Error | null = null
	private readonly abortController = new AbortController()
	private readonly timeoutTimer: ReturnType<typeof setTimeout> | null
	private disposed = false

	private expectedLoaderId: string | undefined
	private initialLoaderId: string | undefined
	private readonly observedLoaderIds = new Set<string>()
	private mainLoaderEventSequence = 0
	private pendingFollowupNavigation = false
	private navigationGateRequired = false
	private navigationCommitted = false
	private resolveNavigationCommit!: () => void
	private readonly navigationCommitPromise: Promise<void>

	/**
	 * Create a watcher; callers should subsequently invoke {@link wait}.
	 */
	constructor(params: {
		page: Page
		mainSession: CDPSessionLike
		networkManager: NetworkManager
		waitUntil: LoadState
		timeoutMs: number
		navigationCommandId: number
		signal?: AbortSignal
		onLoaderIdChanged?: (loaderId: string) => void
	}) {
		this.page = params.page
		this.mainSession = params.mainSession
		this.networkManager = params.networkManager
		this.waitUntil = params.waitUntil
		this.timeoutMs =
			params.timeoutMs > 0 ? params.timeoutMs : Number.POSITIVE_INFINITY
		this.startTime = Date.now()
		this.navigationCommandId = params.navigationCommandId
		this.onLoaderIdChanged = params.onLoaderIdChanged
		this.idleStartTime = this.startTime
		this.initialLoaderId = this.page.mainFrameLoaderId?.()

		this.abortPromise = new Promise<never>((_, reject) => {
			this.abortReject = reject
		})
		this.navigationCommitPromise = new Promise<void>((resolve) => {
			this.resolveNavigationCommit = resolve
		})
		this.timeoutTimer = Number.isFinite(this.timeoutMs)
			? setTimeout(
					() =>
						this.triggerAbort(
							new TimeoutError("Lifecycle wait", this.timeoutMs),
						),
					Math.max(0, this.timeoutMs),
				)
			: null
		// Listeners are live from construction, so an abort can fire before
		// wait() races this promise; observe it to avoid an unhandledRejection.
		void this.abortPromise.catch(() => {})

		this.installSessionListeners()
		if (params.signal) {
			const onAbort = () => {
				this.triggerAbort(
					params.signal?.reason instanceof Error
						? params.signal.reason
						: new Error("Navigation aborted"),
				)
			}
			params.signal.addEventListener("abort", onAbort, { once: true })
			this.cleanupCallbacks.push(() =>
				params.signal?.removeEventListener("abort", onAbort),
			)
			if (params.signal.aborted) {
				onAbort()
			}
		}
	}

	/** Hint the watcher with the loader id returned by Page.navigate. */
	public setExpectedLoaderId(loaderId: string | undefined): void {
		if (!loaderId) {
			return
		}
		this.navigationGateRequired = true
		if (
			this.expectedLoaderId &&
			this.expectedLoaderId !== loaderId &&
			this.observedLoaderIds.has(this.expectedLoaderId)
		) {
			this.markNavigationCommitted()
			return
		}
		this.expectedLoaderId = loaderId
		this.onLoaderIdChanged?.(loaderId)
		this.idleStartTime = Date.now()
		if (this.observedLoaderIds.has(loaderId)) {
			this.markNavigationCommitted()
		}
	}

	public expectNavigationWithoutKnownLoader(): void {
		this.navigationGateRequired = true
		if (
			[...this.observedLoaderIds].some(
				(loaderId) => loaderId !== this.initialLoaderId,
			)
		) {
			this.markNavigationCommitted()
		}
	}

	public allowCurrentDocument(): void {
		this.markNavigationCommitted()
	}

	/** Wait for the requested lifecycle state or throw on timeout/abort. */
	public async wait(): Promise<void> {
		const deadline = this.startTime + this.timeoutMs

		try {
			if (this.navigationGateRequired && !this.navigationCommitted) {
				await this.awaitWithAbort(this.navigationCommitPromise)
			}
			this.assertCurrentNavigation()
			if (this.waitUntil === "domcontentloaded") {
				await this.awaitWithAbort(
					this.page.waitForMainLoadState(
						"domcontentloaded",
						this.timeRemaining(deadline),
						this.abortController.signal,
					),
				)
				this.assertCurrentNavigation()
				return
			}

			while (true) {
				await this.awaitWithAbort(
					this.page.waitForMainLoadState(
						"load",
						this.timeRemaining(deadline),
						this.abortController.signal,
					),
				)
				this.assertCurrentNavigation()

				if (this.waitUntil !== "networkidle") {
					break
				}

				try {
					await this.awaitWithAbort(this.waitForNetworkIdle(deadline))
					this.assertCurrentNavigation()
					break
				} catch (error) {
					if (this.shouldRestartAfterFollowup(error)) {
						continue
					}
					throw error
				}
			}
		} finally {
			this.dispose()
		}

		if (this.abortError) {
			throw this.abortError
		}
	}

	/** Cancel any outstanding network-idle waits and remove event listeners. */
	public dispose(): void {
		if (this.disposed) {
			return
		}
		this.disposed = true
		if (this.timeoutTimer) {
			clearTimeout(this.timeoutTimer)
		}
		if (!this.abortController.signal.aborted) {
			this.abortController.abort(new Error("Lifecycle watcher disposed"))
		}

		if (this.idleHandle) {
			void this.idleHandle.promise.catch(() => {})
			this.idleHandle.dispose()
			this.idleHandle = null
		}

		for (const fn of this.cleanupCallbacks) {
			try {
				fn()
			} catch {}
		}
		this.cleanupCallbacks = []
		this.abortReject = null
	}

	/** Subscribe to main-frame events to detect abort conditions. */
	private installSessionListeners(): void {
		const onFrameNavigated = (evt: Protocol.Page.FrameNavigatedEvent) => {
			if (!evt?.frame?.id) {
				return
			}

			const mainFrameId = this.page.mainFrameId()
			if (evt.frame.id !== mainFrameId) {
				return
			}

			const loaderId = evt.frame.loaderId
			if (!loaderId) {
				return
			}
			const eventSequence = ++this.mainLoaderEventSequence
			const pendingSuperseded = this.page.pendingSupersededNavigation()
			if (
				pendingSuperseded &&
				(!this.expectedLoaderId || loaderId !== this.expectedLoaderId)
			) {
				void pendingSuperseded.then(() => {
					if (this.disposed) {
						return
					}
					if (eventSequence !== this.mainLoaderEventSequence) {
						return
					}
					this.processMainLoader(loaderId)
				})
				return
			}
			this.processMainLoader(loaderId)
		}

		const onFrameDetached = (evt: Protocol.Page.FrameDetachedEvent) => {
			if (!evt?.frameId) {
				return
			}
			const mainFrameId = this.page.mainFrameId()
			if (evt.frameId !== mainFrameId) {
				return
			}
			if (evt.reason === "swap") {
				return
			}
			this.triggerAbort(new Error("Main frame was detached"))
		}
		const onNavigatedWithinDocument = (
			evt: Protocol.Page.NavigatedWithinDocumentEvent,
		) => {
			if (evt.frameId !== this.page.mainFrameId()) {
				return
			}
			if (this.navigationGateRequired && !this.expectedLoaderId) {
				this.markNavigationCommitted()
			}
		}

		this.mainSession.on("Page.frameNavigated", onFrameNavigated)
		this.cleanupCallbacks.push(() => {
			this.mainSession.off("Page.frameNavigated", onFrameNavigated)
		})

		this.mainSession.on("Page.frameDetached", onFrameDetached)
		this.cleanupCallbacks.push(() => {
			this.mainSession.off("Page.frameDetached", onFrameDetached)
		})
		this.mainSession.on(
			"Page.navigatedWithinDocument",
			onNavigatedWithinDocument,
		)
		this.cleanupCallbacks.push(() => {
			this.mainSession.off(
				"Page.navigatedWithinDocument",
				onNavigatedWithinDocument,
			)
		})
	}

	private processMainLoader(loaderId: string): void {
		if (this.page.isSupersededNavigationLoader(loaderId)) {
			return
		}
		this.observedLoaderIds.add(loaderId)
		if (
			this.initialLoaderId &&
			loaderId === this.initialLoaderId &&
			loaderId !== this.expectedLoaderId
		) {
			return
		}

		if (!this.initialLoaderId) {
			this.initialLoaderId = loaderId
			this.idleStartTime = Date.now()
		}
		if (
			this.navigationGateRequired &&
			(!this.expectedLoaderId || loaderId === this.expectedLoaderId)
		) {
			this.markNavigationCommitted()
		}

		if (!this.expectedLoaderId) {
			this.expectedLoaderId = loaderId
			this.onLoaderIdChanged?.(loaderId)
			this.idleStartTime = Date.now()
			if (this.navigationGateRequired) {
				this.markNavigationCommitted()
			}
			return
		}

		if (loaderId !== this.expectedLoaderId) {
			if (!this.page.isCurrentNavigationCommand(this.navigationCommandId)) {
				this.triggerAbort(
					new Error("Navigation was superseded by a new request"),
				)
				return
			}

			this.adoptNewMainLoader(loaderId)
		}
	}

	/** Compute remaining time until the shared deadline elapses. */
	private timeRemaining(deadline: number): number {
		const remaining = deadline - Date.now()
		if (remaining <= 0) {
			throw new TimeoutError("Lifecycle wait", this.timeoutMs)
		}
		return remaining
	}

	/** Await an operation but abort early if navigation replacement fires. */
	private async awaitWithAbort<T>(operation: Promise<T>): Promise<T> {
		try {
			return await Promise.race([operation, this.abortPromise])
		} catch (error) {
			if (this.abortError) {
				throw this.abortError
			}
			throw error
		}
	}

	/** Mark the watcher as aborted and reject any pending waiters. */
	private triggerAbort(error: Error): void {
		if (this.abortError) {
			return
		}
		this.abortError = error
		this.abortController.abort(error)
		if (this.idleHandle) {
			const handle = this.idleHandle
			this.idleHandle = null
			void handle.promise.catch(() => {})
			handle.dispose()
		}
		if (this.abortReject) {
			this.abortReject(error)
			this.abortReject = null
		}
	}

	private markNavigationCommitted(): void {
		if (this.navigationCommitted) {
			return
		}
		this.navigationCommitted = true
		this.resolveNavigationCommit()
	}

	private assertCurrentNavigation(): void {
		if (this.page.isCurrentNavigationCommand(this.navigationCommandId)) {
			return
		}
		const error = new Error("Navigation was superseded by a new request")
		this.triggerAbort(error)
		throw error
	}
	private waitForNetworkIdle(deadline: number): Promise<void> {
		this.pendingFollowupNavigation = false
		const remaining = this.timeRemaining(deadline)
		const idleWindow = Math.min(DEFAULT_IDLE_WAIT, remaining)
		this.idleHandle = this.networkManager.waitForIdle({
			startTime: this.idleStartTime,
			timeoutMs: remaining,
			totalBudgetMs: this.timeoutMs,
			idleTimeMs: idleWindow,
			filter: this.buildIdleFilter(),
		})

		return this.idleHandle.promise.catch((error) => {
			if (this.abortError) {
				throw this.abortError
			}
			throw error
		})
	}

	private shouldRestartAfterFollowup(error: unknown): boolean {
		if (!this.pendingFollowupNavigation) {
			return false
		}
		if (!(error instanceof Error)) {
			return false
		}
		if (error.message !== "waitForIdle disposed") {
			return false
		}
		this.pendingFollowupNavigation = false
		return true
	}

	private adoptNewMainLoader(loaderId: string): void {
		this.expectedLoaderId = loaderId
		this.onLoaderIdChanged?.(loaderId)
		this.idleStartTime = Date.now()
		this.markNavigationCommitted()
		if (this.waitUntil !== "networkidle") {
			return
		}

		this.pendingFollowupNavigation = true

		if (this.idleHandle) {
			const handle = this.idleHandle
			this.idleHandle = null
			void handle.promise.catch(() => {})
			handle.dispose()
		}
	}

	private buildIdleFilter(): (info: NetworkRequestInfo) => boolean {
		return (info: NetworkRequestInfo) => {
			return (
				info.timestamp >= this.startTime &&
				!IGNORED_RESOURCE_TYPES.has(info.resourceType)
			)
		}
	}
}
