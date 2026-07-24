import type { Protocol } from "devtools-protocol"
import {
	DEFAULT_IDLE_WAIT,
	IGNORED_RESOURCE_TYPES,
	type NetworkObserver,
	type NetworkRequestInfo,
	type WaitForIdleHandle,
	type WaitForIdleOptions,
} from "../types/private/network"
import type { CDPEvent, CDPEventParams, CDPSessionLike } from "./cdp"

/**
 * Cross-session network tracker.
 *
 * Centralises network bookkeeping for a Page: every CDP session (top-level and OOPIF)
 * funnels `Network.*` events through here so higher-level waiters can reason about
 * in-flight requests across the entire frame tree. The manager exposes a simple
 * observer interface plus a "wait until idle" helper that resolves once no filtered
 * requests remain for a quiet window.
 */

/**
 * Aggregates network information for all CDP sessions owned by a Page.
 */
export class NetworkManager {
	private readonly sessions = new Map<
		string,
		{
			session: CDPSessionLike
			detach: () => void
		}
	>()

	private readonly observers = new Set<NetworkObserver>()

	private readonly requests = new Map<string, NetworkRequestInfo>()

	private readonly documentRequestsByFrame = new Map<string, string>()

	/**
	 * Cleanups of unsettled `waitForIdle` waiters, so `dispose()` can settle
	 * them before their observers are dropped.
	 */
	private readonly activeIdleCleanups = new Set<(error?: Error) => void>()
	private disposed = false

	/**
	 * Begin tracking network traffic for a CDP session (top-level or OOPIF).
	 * Safe to call multiple times; duplicate registrations are ignored.
	 */
	public trackSession(session: CDPSessionLike): void {
		if (this.disposed) {
			return
		}
		const sid = this.sessionKey(session)
		if (this.sessions.has(sid)) {
			return
		}
		const isCurrent = () =>
			!this.disposed && this.sessions.get(sid)?.session === session

		const onRequest = (evt: Protocol.Network.RequestWillBeSentEvent) => {
			if (!isCurrent()) {
				return
			}
			if (!evt?.requestId) {
				return
			}

			const info: NetworkRequestInfo = {
				sessionId: sid,
				requestId: evt.requestId,
				requestKey: this.requestKey(sid, evt.requestId),
				frameId: evt.frameId ?? undefined,
				loaderId: evt.loaderId ?? undefined,
				url: evt.request?.url,
				timestamp: Date.now(),
				resourceType: evt.type,
				documentRequest: evt.type === "Document",
			}

			this.requests.set(info.requestKey, info)
			if (info.documentRequest && info.frameId) {
				this.documentRequestsByFrame.set(info.frameId, info.requestKey)
			}

			this.emitStart(info)
		}

		const finish = (reqId: string) => {
			if (!isCurrent()) {
				return
			}
			const key = this.requestKey(sid, reqId)
			const stored = this.requests.get(key)
			if (
				stored?.documentRequest &&
				stored.frameId &&
				this.documentRequestsByFrame.get(stored.frameId) === key
			) {
				this.documentRequestsByFrame.delete(stored.frameId)
			}
			const info: NetworkRequestInfo = stored ?? {
				sessionId: sid,
				requestId: reqId,
				requestKey: key,
				timestamp: Date.now(),
				documentRequest: false,
			}
			this.requests.delete(key)
			this.emitFinish(info)
		}

		const fail = (reqId: string) => {
			if (!isCurrent()) {
				return
			}
			const key = this.requestKey(sid, reqId)
			const stored = this.requests.get(key)
			if (
				stored?.documentRequest &&
				stored.frameId &&
				this.documentRequestsByFrame.get(stored.frameId) === key
			) {
				this.documentRequestsByFrame.delete(stored.frameId)
			}
			const info: NetworkRequestInfo = stored ?? {
				sessionId: sid,
				requestId: reqId,
				requestKey: key,
				timestamp: Date.now(),
				documentRequest: false,
			}
			this.requests.delete(key)
			this.emitFailure(info)
		}

		const onFinished = (evt: { requestId: string }) => {
			if (!evt?.requestId) {
				return
			}
			finish(evt.requestId)
		}

		const onFailed = (evt: Protocol.Network.LoadingFailedEvent) => {
			if (!evt?.requestId) {
				return
			}
			fail(evt.requestId)
		}

		const onResponse = (evt: Protocol.Network.ResponseReceivedEvent) => {
			if (!evt?.requestId) {
				return
			}
			const url = evt.response?.url ?? ""
			if (url.startsWith("data:")) {
				finish(evt.requestId)
			}
		}

		const onFrameStopped = (evt: Protocol.Page.FrameStoppedLoadingEvent) => {
			if (!isCurrent()) {
				return
			}
			if (!evt?.frameId) {
				return
			}
			const key = this.documentRequestsByFrame.get(evt.frameId)
			if (!key) {
				return
			}
			const stored = this.requests.get(key)
			if (!stored || stored.sessionId !== sid) {
				if (!stored) {
					this.documentRequestsByFrame.delete(evt.frameId)
				}
				return
			}
			this.requests.delete(key)
			this.documentRequestsByFrame.delete(evt.frameId)
			this.emitFinish({ ...stored, timestamp: Date.now() })
		}

		const removers: Array<() => void> = []
		const listen = <E extends CDPEvent>(
			event: E,
			handler: (params: CDPEventParams<E>) => void,
		) => {
			session.on(event, handler)
			removers.push(() => session.off(event, handler))
		}
		try {
			listen("Network.requestWillBeSent", onRequest)
			listen("Network.loadingFinished", onFinished)
			listen("Network.loadingFailed", onFailed)
			listen("Network.requestServedFromCache", onFinished)
			listen("Network.responseReceived", onResponse)
			listen("Page.frameStoppedLoading", onFrameStopped)
		} catch (error) {
			for (const remove of removers) {
				try {
					remove()
				} catch {}
			}
			throw error
		}
		this.sessions.set(sid, {
			session,
			detach: () => {
				for (const remove of removers) {
					try {
						remove()
					} catch {}
				}
			},
		})

		try {
			void session.send("Network.enable").catch(() => {})
		} catch {}
		try {
			void session.send("Page.enable").catch(() => {})
		} catch {}
	}

	/**
	 * Stop tracking a session and discard any inflight bookkeeping owned by it.
	 */
	public untrackSession(rawSessionId: string | undefined): void {
		const sid = rawSessionId ?? "__main__"
		const entry = this.sessions.get(sid)
		if (!entry) {
			return
		}
		try {
			entry.detach()
		} finally {
			this.sessions.delete(sid)
		}

		for (const [key, info] of [...this.requests.entries()]) {
			if (info.sessionId !== sid) {
				continue
			}
			this.requests.delete(key)
			this.emitFailure(info)
		}

		for (const [frameId, key] of [...this.documentRequestsByFrame.entries()]) {
			if (key.startsWith(`${sid}:`)) {
				this.documentRequestsByFrame.delete(frameId)
			}
		}
	}

	/**
	 * Register a passive observer for request lifecycle notifications.
	 * Returns a disposer that removes the observer.
	 */
	public addObserver(observer: NetworkObserver): () => void {
		if (this.disposed) {
			return () => {}
		}
		this.observers.add(observer)
		return () => {
			this.observers.delete(observer)
		}
	}

	/**
	 * Resolve once no (filtered) requests are in flight for the given quiet window.
	 * The waiter automatically unregisters itself on completion or timeout.
	 */
	public waitForIdle(options: WaitForIdleOptions): WaitForIdleHandle {
		if (this.disposed) {
			const promise = Promise.reject(new Error("NetworkManager disposed"))
			void promise.catch(() => {})
			return { promise, dispose: () => {} }
		}
		const startTime = options.startTime ?? Date.now()
		const idleTimeMs = options.idleTimeMs ?? DEFAULT_IDLE_WAIT
		const timeoutMs = options.timeoutMs
		const remainingBudgetMs = Number.isFinite(timeoutMs) ? timeoutMs : undefined
		const totalBudgetMs = options.totalBudgetMs
		const originalBudgetMs =
			typeof totalBudgetMs === "number" && Number.isFinite(totalBudgetMs)
				? totalBudgetMs
				: remainingBudgetMs

		const filter =
			options.filter ??
			((info: NetworkRequestInfo) => {
				return !IGNORED_RESOURCE_TYPES.has(info.resourceType)
			})

		const tracked = new Set<string>()
		let idleTimer: ReturnType<typeof setTimeout> | null = null
		let timeoutTimer: ReturnType<typeof setTimeout> | null = null
		let settled = false

		let resolveFn: (() => void) | null = null
		let rejectFn: ((error: Error) => void) | null = null

		const cleanup = (error?: Error) => {
			if (settled) {
				return
			}
			settled = true
			if (idleTimer) {
				clearTimeout(idleTimer)
			}
			if (timeoutTimer) {
				clearTimeout(timeoutTimer)
			}
			removeObserver()
			this.activeIdleCleanups.delete(cleanup)
			tracked.clear()
			if (error) {
				rejectFn?.(error)
			} else {
				resolveFn?.()
			}
		}
		this.activeIdleCleanups.add(cleanup)

		const maybeIdle = () => {
			if (settled) {
				return
			}
			if (tracked.size === 0) {
				if (!idleTimer) {
					idleTimer = setTimeout(() => {
						cleanup()
					}, idleTimeMs)
				}
			} else if (idleTimer) {
				clearTimeout(idleTimer)
				idleTimer = null
			}
		}

		const observer: NetworkObserver = {
			onRequestStarted: (info) => {
				if (settled) {
					return
				}
				if (info.timestamp < startTime) {
					return
				}
				if (!filter(info)) {
					return
				}
				tracked.add(info.requestKey)
				if (idleTimer) {
					clearTimeout(idleTimer)
					idleTimer = null
				}
			},
			onRequestFinished: (info) => {
				if (settled) {
					return
				}
				if (!tracked.delete(info.requestKey)) {
					return
				}
				maybeIdle()
			},
			onRequestFailed: (info) => {
				if (settled) {
					return
				}
				if (!tracked.delete(info.requestKey)) {
					return
				}
				maybeIdle()
			},
		}

		const removeObserver = this.addObserver(observer)

		const promise = new Promise<void>((resolve, reject) => {
			resolveFn = resolve
			rejectFn = reject
		})
		// The waiter can be rejected externally before the caller awaits it.
		void promise.catch(() => {})

		// Requests already in flight when the waiter is created are still part of
		// the page's idle state, regardless of when they originally started.
		for (const info of this.requests.values()) {
			if (filter(info)) {
				tracked.add(info.requestKey)
			}
		}

		// Trigger initial idle check so that we still respect the quiet window
		maybeIdle()

		if (Number.isFinite(timeoutMs)) {
			timeoutTimer = setTimeout(
				() => {
					const elapsed = Date.now() - startTime
					const message =
						originalBudgetMs !== undefined
							? `networkidle timed out after ${originalBudgetMs}ms`
							: `networkidle timed out after ${elapsed}ms`
					cleanup(new Error(message))
				},
				Math.max(0, timeoutMs),
			)
		}

		return {
			promise,
			dispose: () => cleanup(new Error("waitForIdle disposed")),
		}
	}

	/**
	 * Tear down all session listeners and clear observers/bookkeeping.
	 */
	public dispose(): void {
		if (this.disposed) {
			return
		}
		this.disposed = true
		for (const cleanup of Array.from(this.activeIdleCleanups)) {
			cleanup(new Error("NetworkManager disposed"))
		}
		for (const { detach } of this.sessions.values()) {
			try {
				detach()
			} catch {}
		}
		this.sessions.clear()
		this.observers.clear()
		this.requests.clear()
		this.documentRequestsByFrame.clear()
	}

	/** Fan-out helper when a tracked request starts. */
	private emitStart(info: NetworkRequestInfo): void {
		for (const obs of this.observers) {
			try {
				obs.onRequestStarted(info)
			} catch {}
		}
	}

	/** Fan-out helper when a tracked request completes successfully. */
	private emitFinish(info: NetworkRequestInfo): void {
		for (const obs of this.observers) {
			try {
				obs.onRequestFinished(info)
			} catch {}
		}
	}

	/** Fan-out helper when a tracked request fails mid-flight. */
	private emitFailure(info: NetworkRequestInfo): void {
		for (const obs of this.observers) {
			try {
				obs.onRequestFailed(info)
			} catch {}
		}
	}

	/** Compute a stable key for a session (falls back to synthetic root id). */
	private sessionKey(session: CDPSessionLike): string {
		return session.id ?? "__main__"
	}

	/** Compose the unique key for tracking a request under a session. */
	private requestKey(sessionId: string, requestId: string): string {
		return `${sessionId}:${requestId}`
	}
}
