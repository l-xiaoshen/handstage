/**
 * NavigationResponseTracker
 * -------------------------
 *
 * Tracks DevTools Protocol network events for a single navigation command so
 * Handstage can surface a Playwright-like response object from `Page.goto` and
 * related APIs. The tracker listens for `Network.responseReceived` events that
 * correspond to the targeted document navigation, handles loader-id churn that
 * arises from redirects or preloading, and enriches the resulting
 * `Response` with extra header information. It also observes
 * `Network.loadingFinished` / `Network.loadingFailed` to fulfil the
 * `response.finished()` contract exposed to consumers.
 */

import type { Protocol } from "devtools-protocol"
import { CDPConnectionClosedError } from "../types/public/sdkErrors"
import type {
	CDPConnectionLike,
	CDPEvent,
	CDPEventParams,
	CDPSessionLike,
} from "./cdp"
import type { Page } from "./page"
import { Response } from "./response"

const MAX_PENDING_NETWORK_EVENTS = 256

/**
 * Watches CDP events on a given session and resolves with the navigation's
 * primary document response once identified.
 */
export class NavigationResponseTracker {
	private readonly page: Page
	private readonly session: CDPSessionLike
	private readonly connection: CDPConnectionLike
	private readonly navigationCommandId: number
	private readonly initialLoaderId: string | undefined

	private expectedLoaderId: string | undefined
	private selectedRequestId: string | null = null
	private selectedResponse: Response | null = null
	private terminalError: Error | null = null
	private acceptNextWithoutLoader = false
	private disposed = false
	private listeningDetached = false
	private listeningDestroyed = false
	private listeningConnectionClosed = false

	private responseResolved = false
	private resolveResponse!: (value: Response | null) => void
	private responsePromise: Promise<Response | null>

	private readonly pendingResponsesByLoader = new Map<
		string,
		Protocol.Network.ResponseReceivedEvent
	>()
	private readonly pendingExtraInfo = new Map<
		string,
		Protocol.Network.ResponseReceivedExtraInfoEvent
	>()
	private readonly pendingTerminalEvents = new Map<string, Error | null>()

	private readonly listenerCleanups: Array<() => void> = []

	/**
	 * Create a tracker bound to a specific navigation command. The tracker begins
	 * listening for network events immediately so it should be constructed before
	 * the navigation request is dispatched.
	 */
	constructor(params: {
		page: Page
		session: CDPSessionLike
		connection: CDPConnectionLike
		navigationCommandId: number
	}) {
		this.page = params.page
		this.session = params.session
		this.connection = params.connection
		this.navigationCommandId = params.navigationCommandId
		this.initialLoaderId = this.page.mainFrameLoaderId?.()

		this.responsePromise = new Promise<Response | null>((resolve) => {
			this.resolveResponse = (value) => {
				if (this.responseResolved) {
					return
				}
				this.responseResolved = true
				resolve(value)
			}
		})

		try {
			this.installListeners()
			this.connection.on("Target.detachedFromTarget", this.onSessionDetached)
			this.listeningDetached = true
			this.connection.on("Target.targetDestroyed", this.onTargetDestroyed)
			this.listeningDestroyed = true
			this.connection.onTransportClosed(this.onConnectionClosed)
			this.listeningConnectionClosed = true
		} catch (error) {
			this.dispose()
			throw error
		}
	}

	/** Stop listening for CDP events and release any pending bookkeeping. */
	public dispose(): void {
		if (this.disposed) {
			return
		}
		this.disposed = true
		for (const cleanup of this.listenerCleanups) {
			try {
				cleanup()
			} catch {}
		}
		this.listenerCleanups.length = 0
		this.pendingResponsesByLoader.clear()
		this.pendingExtraInfo.clear()
		this.pendingTerminalEvents.clear()
		if (!this.selectedResponse) {
			this.resolveResponse(null)
		}
		this.releaseConnectionListeners()
	}

	private onSessionDetached = (
		event: Protocol.Target.DetachedFromTargetEvent,
	): void => {
		if (!this.session.id || event.sessionId !== this.session.id) {
			return
		}
		this.handleTerminalError(new Error("Navigation session detached"))
	}

	private onConnectionClosed = (why: string): void => {
		this.handleTerminalError(new CDPConnectionClosedError(why))
	}

	private onTargetDestroyed = (
		event: Protocol.Target.TargetDestroyedEvent,
	): void => {
		if (event.targetId !== this.page.targetId()) {
			return
		}
		this.handleTerminalError(new Error("Navigation target destroyed"))
	}

	private handleTerminalError(error: Error): void {
		if (this.terminalError) {
			return
		}
		this.terminalError = error
		if (!this.selectedResponse) {
			this.resolveResponse(null)
		}
	}

	private releaseConnectionListeners(): void {
		if (this.listeningDetached) {
			this.listeningDetached = false
			try {
				this.connection.off("Target.detachedFromTarget", this.onSessionDetached)
			} catch {}
		}
		if (this.listeningDestroyed) {
			this.listeningDestroyed = false
			try {
				this.connection.off("Target.targetDestroyed", this.onTargetDestroyed)
			} catch {}
		}
		if (this.listeningConnectionClosed) {
			this.listeningConnectionClosed = false
			try {
				this.connection.offTransportClosed(this.onConnectionClosed)
			} catch {}
		}
	}

	/**
	 * Hint the tracker with the loader id returned by `Page.navigate`. Chrome only
	 * emits this once the browser begins navigating, so we store early responses
	 * and match them once the loader id is known.
	 */
	public setExpectedLoaderId(loaderId: string | undefined): void {
		if (!loaderId) {
			return
		}
		this.expectedLoaderId = loaderId
		const pending = this.pendingResponsesByLoader.get(loaderId)
		if (pending) {
			this.pendingResponsesByLoader.delete(loaderId)
			this.selectResponse(pending)
		}
	}

	/**
	 * Some navigation APIs (reload/history traversal) do not provide a loader id
	 * up front. This flag instructs the tracker to accept the next qualifying
	 * document response even if no loader id has been announced yet.
	 */
	public expectNavigationWithoutKnownLoader(): void {
		this.acceptNextWithoutLoader = true
	}

	/**
	 * Returns a promise that resolves with the matched response (or `null` when
	 * no document response was observed).
	 */
	public async navigationCompleted(): Promise<Response | null> {
		if (!this.responseResolved) {
			queueMicrotask(() => {
				if (!this.responseResolved) {
					this.resolveResponse(null)
				}
			})
		}
		return this.responsePromise
	}

	/** Expose the raw response promise (mainly for tests). */
	public async response(): Promise<Response | null> {
		return this.responsePromise
	}

	/** Register all CDP listeners relevant to navigation tracking. */
	private installListeners(): void {
		this.addListener("Network.responseReceived", (event) => {
			this.onResponseReceived(event)
		})
		this.addListener("Network.responseReceivedExtraInfo", (event) => {
			this.onResponseReceivedExtraInfo(event)
		})
		this.addListener("Network.loadingFinished", (event) => {
			this.onLoadingFinished(event)
		})
		this.addListener("Network.loadingFailed", (event) => {
			this.onLoadingFailed(event)
		})
	}

	/** Attach a CDP listener and track it for later disposal. */
	private addListener<E extends CDPEvent>(
		event: E,
		handler: (event: CDPEventParams<E>) => void,
	): void {
		this.session.on(event, handler)
		this.listenerCleanups.push(() => this.session.off(event, handler))
	}

	/** Handle the initial response payload for document navigations. */
	private onResponseReceived(
		event: Protocol.Network.ResponseReceivedEvent,
	): void {
		if (!this.page.isCurrentNavigationCommand(this.navigationCommandId)) {
			return
		}
		if (!event?.response) {
			return
		}
		if (event.type !== "Document") {
			return
		}
		const loaderId = event.loaderId ?? ""
		if (event.frameId !== this.page.mainFrameId()) {
			if (loaderId) {
				this.storePendingResponse(loaderId, event)
			}
			return
		}
		if (this.acceptNextWithoutLoader) {
			if (!loaderId || loaderId === this.initialLoaderId) {
				return
			}
			this.acceptNextWithoutLoader = false
			this.expectedLoaderId = loaderId
			this.selectResponse(event)
			return
		}

		if (this.expectedLoaderId) {
			if (loaderId && loaderId !== this.expectedLoaderId) {
				this.storePendingResponse(loaderId, event)
				return
			}
			this.selectResponse(event)
			return
		}

		if (loaderId) {
			this.storePendingResponse(loaderId, event)
			return
		}

		this.selectResponse(event)
	}

	/** Merge auxiliary header information once Chrome exposes it. */
	private onResponseReceivedExtraInfo(
		event: Protocol.Network.ResponseReceivedExtraInfoEvent,
	): void {
		if (!event?.requestId) {
			return
		}
		if (this.selectedRequestId && event.requestId === this.selectedRequestId) {
			this.selectedResponse?.applyExtraInfo(event)
			return
		}
		if (this.selectedResponse) {
			return
		}
		this.setBounded(this.pendingExtraInfo, event.requestId, event)
	}

	private onLoadingFinished(
		event: Protocol.Network.LoadingFinishedEvent,
	): void {
		if (!event?.requestId) {
			return
		}
		if (event.requestId === this.selectedRequestId && this.selectedResponse) {
			this.selectedResponse.markFinished(null)
			return
		}
		if (this.isPendingRequest(event.requestId)) {
			this.setBounded(this.pendingTerminalEvents, event.requestId, null)
		}
	}

	private onLoadingFailed(event: Protocol.Network.LoadingFailedEvent): void {
		if (!event?.requestId) {
			return
		}
		const error = new Error(event.errorText || "Navigation request failed")
		if (event.requestId === this.selectedRequestId && this.selectedResponse) {
			this.selectedResponse.markFinished(error)
			return
		}
		if (this.isPendingRequest(event.requestId)) {
			this.setBounded(this.pendingTerminalEvents, event.requestId, error)
		}
	}

	private storePendingResponse(
		loaderId: string,
		event: Protocol.Network.ResponseReceivedEvent,
	): void {
		const replaced = this.pendingResponsesByLoader.get(loaderId)
		if (replaced && replaced.requestId !== event.requestId) {
			this.pendingExtraInfo.delete(replaced.requestId)
			this.pendingTerminalEvents.delete(replaced.requestId)
		}
		this.setBounded(this.pendingResponsesByLoader, loaderId, event)
	}

	private isPendingRequest(requestId: string): boolean {
		for (const event of this.pendingResponsesByLoader.values()) {
			if (event.requestId === requestId) {
				return true
			}
		}
		return false
	}

	private setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
		map.delete(key)
		map.set(key, value)
		while (map.size > MAX_PENDING_NETWORK_EVENTS) {
			const oldest = map.keys().next()
			if (oldest.done) {
				break
			}
			map.delete(oldest.value)
		}
	}

	/**
	 * Create the `Response` wrapper for the chosen document response and
	 * resolve awaiting consumers. Subsequent events flesh out the header/body
	 * helpers and mark the request as finished.
	 */
	private selectResponse(event: Protocol.Network.ResponseReceivedEvent): void {
		if (event.loaderId) {
			this.pendingResponsesByLoader.delete(event.loaderId)
		}

		if (this.responseResolved) {
			return
		}
		if (this.selectedResponse) {
			return
		}

		const protocol = event.response?.protocol?.toLowerCase() ?? ""
		const url = event.response?.url ?? ""
		const isDataUrl = protocol === "data" || url.startsWith("data:")
		const isAboutUrl = protocol === "about" || url.startsWith("about:")

		if (isDataUrl || isAboutUrl) {
			this.pendingExtraInfo.delete(event.requestId)
			this.pendingTerminalEvents.delete(event.requestId)
			this.selectedRequestId = null
			this.selectedResponse = null
			this.resolveResponse(null)
			return
		}

		const response = new Response({
			page: this.page,
			session: this.session,
			connection: this.connection,
			requestId: event.requestId,
			frameId: event.frameId,
			loaderId: event.loaderId,
			response: event.response,
			fromServiceWorker: Boolean(event.response?.fromServiceWorker),
		})

		this.selectedRequestId = event.requestId
		this.selectedResponse = response
		this.releaseConnectionListeners()

		const extraInfo = this.pendingExtraInfo.get(event.requestId)
		if (extraInfo) {
			response.applyExtraInfo(extraInfo)
			this.pendingExtraInfo.delete(event.requestId)
		}
		if (this.pendingTerminalEvents.has(event.requestId)) {
			response.markFinished(
				this.pendingTerminalEvents.get(event.requestId) ?? null,
			)
			this.pendingTerminalEvents.delete(event.requestId)
		}
		this.pendingResponsesByLoader.clear()
		this.pendingExtraInfo.clear()
		this.pendingTerminalEvents.clear()

		this.resolveResponse(response)
	}
}
