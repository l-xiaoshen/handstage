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
import type { CDPEvent, CDPEventParams, CDPSessionLike } from "./cdp"
import type { Page } from "./page"
import { Response } from "./response"

/**
 * Watches CDP events on a given session and resolves with the navigation's
 * primary document response once identified.
 */
export class NavigationResponseTracker {
	private readonly page: Page
	private readonly session: CDPSessionLike
	private readonly navigationCommandId: number

	private expectedLoaderId: string | undefined
	private selectedRequestId: string | null = null
	private selectedResponse: Response | null = null
	private acceptNextWithoutLoader = false

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

	private readonly listeners: Array<{
		event: CDPEvent
		handler: (event: unknown) => void
	}> = []

	/**
	 * Create a tracker bound to a specific navigation command. The tracker begins
	 * listening for network events immediately so it should be constructed before
	 * the navigation request is dispatched.
	 */
	constructor(params: {
		page: Page
		session: CDPSessionLike
		navigationCommandId: number
	}) {
		this.page = params.page
		this.session = params.session
		this.navigationCommandId = params.navigationCommandId

		this.responsePromise = new Promise<Response | null>((resolve) => {
			this.resolveResponse = (value) => {
				if (this.responseResolved) return
				this.responseResolved = true
				resolve(value)
			}
		})

		this.installListeners()
	}

	/** Stop listening for CDP events and release any pending bookkeeping. */
	public dispose(): void {
		for (const { event, handler } of this.listeners) {
			this.session.off(event, handler as never)
		}
		this.listeners.length = 0
		this.pendingResponsesByLoader.clear()
		this.pendingExtraInfo.clear()
	}

	/**
	 * Hint the tracker with the loader id returned by `Page.navigate`. Chrome only
	 * emits this once the browser begins navigating, so we store early responses
	 * and match them once the loader id is known.
	 */
	public setExpectedLoaderId(loaderId: string | undefined): void {
		if (!loaderId) return
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
				if (!this.responseResolved) this.resolveResponse(null)
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
		// loadingFinished/Failed are intentionally NOT tracked here: this tracker
		// is disposed when the navigation wait completes (Page.goto's finally),
		// usually before loadingFinished arrives — owning the finish listeners
		// here would make response.finished() hang. It's handed off to the
		// Page-owned watcher (page.watchResponseFinish) instead.
	}

	/** Attach a CDP listener and track it for later disposal. */
	private addListener<E extends CDPEvent>(
		event: E,
		handler: (event: CDPEventParams<E>) => void,
	): void {
		this.session.on(event, handler)
		this.listeners.push({ event, handler: handler as (event: unknown) => void })
	}

	/** Handle the initial response payload for document navigations. */
	private onResponseReceived(
		event: Protocol.Network.ResponseReceivedEvent,
	): void {
		if (!this.page.isCurrentNavigationCommand(this.navigationCommandId)) return
		if (!event?.response) return
		if (event.type !== "Document") return
		if (event.frameId !== this.page.mainFrameId()) return

		const loaderId = event.loaderId ?? ""
		if (this.acceptNextWithoutLoader) {
			this.acceptNextWithoutLoader = false
			this.selectResponse(event)
			return
		}

		if (this.expectedLoaderId) {
			if (loaderId && loaderId !== this.expectedLoaderId) {
				this.pendingResponsesByLoader.set(loaderId, event)
				return
			}
			this.selectResponse(event)
			return
		}

		if (loaderId) {
			this.pendingResponsesByLoader.set(loaderId, event)
			return
		}

		this.selectResponse(event)
	}

	/** Merge auxiliary header information once Chrome exposes it. */
	private onResponseReceivedExtraInfo(
		event: Protocol.Network.ResponseReceivedExtraInfoEvent,
	): void {
		if (!event?.requestId) return
		if (this.selectedRequestId && event.requestId === this.selectedRequestId) {
			this.selectedResponse?.applyExtraInfo(event)
			return
		}
		this.pendingExtraInfo.set(event.requestId, event)
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

		if (this.responseResolved) return
		if (this.selectedResponse) return

		const protocol = event.response?.protocol?.toLowerCase() ?? ""
		const url = event.response?.url ?? ""
		const isDataUrl = protocol === "data" || url.startsWith("data:")
		const isAboutUrl = protocol === "about" || url.startsWith("about:")

		if (isDataUrl || isAboutUrl) {
			this.pendingExtraInfo.delete(event.requestId)
			this.selectedRequestId = null
			this.selectedResponse = null
			this.resolveResponse(null)
			return
		}

		const response = new Response({
			page: this.page,
			session: this.session,
			requestId: event.requestId,
			frameId: event.frameId,
			loaderId: event.loaderId,
			response: event.response,
			fromServiceWorker: Boolean(event.response?.fromServiceWorker),
		})

		this.selectedRequestId = event.requestId
		this.selectedResponse = response

		const extraInfo = this.pendingExtraInfo.get(event.requestId)
		if (extraInfo) {
			response.applyExtraInfo(extraInfo)
			this.pendingExtraInfo.delete(event.requestId)
		}

		// Hand off `response.finished()` resolution to a Page-owned watcher so it
		// survives this tracker's imminent disposal (see installListeners note).
		this.page.watchResponseFinish(this.session, event.requestId, response)

		this.resolveResponse(response)
	}
}
