import {
	CDPConnectionClosedError,
	HandstageTransportAlreadyOwnedError,
	PageNotFoundError,
} from "../../types/public/sdkErrors"
import { unrefTimer } from "../abortUtils"
import { BaseCDPConnection } from "./baseConnection"
import {
	type EventHandler,
	invokeEventHandler,
	type LateResponseHandler,
	type LateResultCallbacks,
} from "./internal"
import {
	ABANDONED_OWNER,
	deleteOwnership,
	getOwnership,
	SESSION_OWNED,
	setOwnership,
} from "./ownership"
import type {
	CDPAnyCommandResult,
	CDPAnyEventParams,
	CDPCommand,
	CDPCommandParams,
	CDPCommandResult,
	CDPEvent,
	CDPEventParams,
	CDPSessionLike,
	ExternalCDPSession,
} from "./protocol"
import { ExternalSessionAdapter } from "./sessions"

export class ExternalConnectionAdapter extends BaseCDPConnection {
	private transportCloseHandlers = new Set<(why: string) => void>()
	private sessions = new Map<string, CDPSessionLike>()
	private eventHandlers = new Map<string, Set<EventHandler>>()
	private rootEventHandlers = new Map<CDPEvent, EventHandler>()
	private sessionToTarget = new Map<string, string>()
	private unclaimedAttachSessions = new Map<string, string>()
	private pendingSends = new Set<(error: Error) => void>()
	private lateResultHandlers = new Set<LateResponseHandler>()
	private closeReason: string | null = null
	private closePromise: Promise<void> | null = null
	private stateReleased = false
	private readonly previousOnClose: ExternalCDPSession["onclose"]
	private readonly adapterOnClose = (reason: string): void => {
		const why = `external-session-close reason=${reason}`
		const closeHandlers = this.enterTerminalState(why)
		this.releaseRetainedState()
		this.releaseExternalOwnership()
		try {
			this.previousOnClose?.(reason)
		} finally {
			if (closeHandlers) {
				this.emitTransportClosed(closeHandlers, why)
			}
		}
	}

	constructor(private externalSession: ExternalCDPSession) {
		super()
		this.previousOnClose = externalSession.onclose
		const owned = getOwnership(externalSession, SESSION_OWNED)
		if (owned) {
			throw new HandstageTransportAlreadyOwnedError("session")
		}
		try {
			setOwnership(externalSession, SESSION_OWNED, this)
			this.externalSession.onclose = this.adapterOnClose
			// Listen for flattened child session events if the external wrapper passes them.
			this.on("Target.attachedToTarget", (params) => {
				if (this.unclaimedAttachSessions.has(params.sessionId)) {
					this.cleanupChildSession(
						params.sessionId,
						params.targetInfo.targetId,
						false,
					)
					return
				}
				if (params?.sessionId && !this.sessions.has(params.sessionId)) {
					this.sessions.set(
						params.sessionId,
						new ExternalSessionAdapter(this, params.sessionId),
					)
				}
				if (params?.sessionId && params.targetInfo?.targetId) {
					this.sessionToTarget.set(params.sessionId, params.targetInfo.targetId)
				}
			})
			this.on("Target.detachedFromTarget", (params) => {
				if (params?.sessionId) {
					this.cleanupChildSession(params.sessionId, params.targetId)
					this.unclaimedAttachSessions.delete(params.sessionId)
				}
			})
			this.on("Target.targetDestroyed", (params) => {
				if (!params?.targetId) {
					return
				}
				for (const pending of this.pendingAttaches) {
					if (pending.targetId === params.targetId) {
						pending.targetDestroyed = true
					}
				}
				for (const [sessionId, targetId] of [
					...this.sessionToTarget.entries(),
				]) {
					if (targetId === params.targetId) {
						this.cleanupChildSession(sessionId, params.targetId)
					}
				}
				for (const [sessionId, targetId] of this.unclaimedAttachSessions) {
					if (targetId === params.targetId) {
						this.unclaimedAttachSessions.delete(sessionId)
					}
				}
			})
		} catch (error) {
			this.releaseRetainedState()
			this.releaseExternalOwnership()
			throw error
		}
	}

	private emitTransportClosed(
		handlers: Iterable<(why: string) => void>,
		why: string,
	): void {
		for (const h of handlers) {
			try {
				h(why)
			} catch {}
		}
	}

	private enterTerminalState(why: string): Set<(why: string) => void> | null {
		if (this.closeReason) {
			return null
		}
		this.closeReason = why
		this.resetAutoAttach()
		const error = new CDPConnectionClosedError(why)
		for (const reject of [...this.pendingSends]) {
			reject(error)
		}
		this.pendingSends.clear()
		for (const late of this.lateResultHandlers) {
			late.handle = undefined
			late.settled = undefined
		}
		this.lateResultHandlers.clear()
		this.rejectAllSessionDispatches(error)
		return new Set(this.transportCloseHandlers)
	}

	private cleanupChildSession(
		sessionId: string,
		targetId?: string,
		recordDetach = true,
	): void {
		if (recordDetach) {
			for (const pending of this.pendingAttaches) {
				if (!targetId || pending.targetId === targetId) {
					pending.detachedSessionIds.add(sessionId)
				}
			}
		}
		this.sessions.delete(sessionId)
		this.sessionToTarget.delete(sessionId)
		this.rejectSessionDispatchesForSession(
			sessionId,
			new PageNotFoundError(`sessionId=${sessionId}`),
		)
	}

	private releaseRetainedState(): void {
		if (this.stateReleased) {
			return
		}
		this.stateReleased = true
		const rootHandlers = [...this.rootEventHandlers.entries()]
		this.rootEventHandlers.clear()
		this.eventHandlers.clear()
		this.transportCloseHandlers.clear()
		this.sessions.clear()
		this.sessionToTarget.clear()
		this.pendingAttaches.clear()
		this.unclaimedAttachSessions.clear()
		for (const late of this.lateResultHandlers) {
			late.handle = undefined
			late.settled = undefined
		}
		this.lateResultHandlers.clear()

		for (const [event, handler] of rootHandlers) {
			try {
				this.externalSession.off(event, handler)
			} catch {}
		}

		try {
			if (this.externalSession.onclose === this.adapterOnClose) {
				this.externalSession.onclose = this.previousOnClose
			}
		} catch {}
	}

	private releaseExternalOwnership(includeAbandoned = false): void {
		try {
			if (
				getOwnership(this.externalSession, SESSION_OWNED) === this ||
				(includeAbandoned &&
					getOwnership(this.externalSession, SESSION_OWNED) === ABANDONED_OWNER)
			) {
				deleteOwnership(this.externalSession, SESSION_OWNED)
			}
		} catch {}
	}

	private ownsExternalSession(): boolean {
		return getOwnership(this.externalSession, SESSION_OWNED) === this
	}

	get id() {
		return this.externalSession.id
	}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendInternal(method, undefined, undefined, ...params)
	}

	sendWithSignal<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendInternal(method, signal, undefined, ...params)
	}

	sendWithSignalAndLateResult<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		onLateResult: (result: CDPCommandResult<M>) => void | Promise<void>,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendInternal(
			method,
			signal,
			{ handle: onLateResult },
			...params,
		)
	}

	private sendInternal<M extends CDPCommand>(
		method: M,
		signal: AbortSignal | undefined,
		lateResult: LateResultCallbacks<CDPCommandResult<M>> | undefined,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		if (this.closeReason) {
			return Promise.reject(new CDPConnectionClosedError(this.closeReason))
		}
		if (signal?.aborted) {
			return Promise.reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error("CDP command aborted"),
			)
		}
		return new Promise<CDPCommandResult<M>>((resolve, reject) => {
			const pendingSends = this.pendingSends
			const lateResultHandlers = this.lateResultHandlers
			const lateResponse: LateResponseHandler | undefined = lateResult
				? {
						handle: lateResult.handle as (
							result: CDPAnyCommandResult,
						) => void | Promise<void>,
						retained: lateResult.retained,
						settled: lateResult.settled,
						sessionId: null,
					}
				: undefined
			let settled = false
			let aborted = false
			let dispatched = false
			const takeLateResponse = () => {
				if (!lateResponse) {
					return undefined
				}
				lateResultHandlers.delete(lateResponse)
				const callbacks = {
					handle: lateResponse.handle,
					settled: lateResponse.settled,
				}
				lateResponse.handle = undefined
				lateResponse.retained = undefined
				lateResponse.settled = undefined
				return callbacks
			}
			const finishLateResponse = (
				result: CDPCommandResult<M> | undefined,
				handleResult: boolean,
			) => {
				const callbacks = takeLateResponse()
				if (!callbacks) {
					return
				}
				if (handleResult && callbacks.handle) {
					try {
						const cleanup = callbacks.handle(result as CDPAnyCommandResult)
						void Promise.resolve(cleanup).catch(() => {})
					} catch {}
				}
				try {
					callbacks.settled?.()
				} catch {}
			}
			const cleanup = () => {
				pendingSends.delete(rejectPending)
				signal?.removeEventListener("abort", onAbort)
			}
			const rejectPending = (error: Error) => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				if (!aborted) {
					takeLateResponse()
				}
				reject(error)
			}
			const resolvePending = (result: CDPCommandResult<M>) => {
				if (aborted) {
					finishLateResponse(result, true)
					return
				}
				if (settled) {
					return
				}
				settled = true
				cleanup()
				takeLateResponse()
				resolve(result)
			}
			const rejectExternal = (error: unknown) => {
				if (aborted) {
					finishLateResponse(undefined, false)
					return
				}
				if (settled) {
					return
				}
				settled = true
				cleanup()
				takeLateResponse()
				reject(error)
			}
			const onAbort = () => {
				if (settled) {
					return
				}
				aborted = true
				if (lateResponse && dispatched) {
					const retained = lateResponse.retained
					lateResponse.retained = undefined
					try {
						retained?.()
					} catch {}
					lateResultHandlers.add(lateResponse)
				}
				rejectPending(
					signal?.reason instanceof Error
						? signal.reason
						: new Error("CDP command aborted"),
				)
			}

			pendingSends.add(rejectPending)
			signal?.addEventListener("abort", onAbort, { once: true })
			if (signal?.aborted) {
				onAbort()
				return
			}
			let command: Promise<CDPCommandResult<M>>
			try {
				dispatched = true
				command = this.externalSession.send(method, ...params)
			} catch (error) {
				dispatched = false
				rejectExternal(error)
				return
			}
			command.then(resolvePending, rejectExternal)
		})
	}

	private ensureRootListener<E extends CDPEvent>(event: E) {
		if (!this.rootEventHandlers.has(event)) {
			const rootHandler = (params: CDPAnyEventParams) => {
				const rootHandlers = this.eventHandlers.get(event)
				if (rootHandlers) {
					for (const h of rootHandlers) {
						invokeEventHandler(h, params)
					}
				}
			}
			this.rootEventHandlers.set(event, rootHandler)
			try {
				this.externalSession.on(event, rootHandler)
			} catch (error) {
				try {
					this.externalSession.off(event, rootHandler)
				} catch {}
				this.rootEventHandlers.delete(event)
				throw error
			}
		}
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		if (this.closeReason) {
			throw new CDPConnectionClosedError(this.closeReason)
		}
		let set = this.eventHandlers.get(event)
		if (!set) {
			set = new Set()
			this.eventHandlers.set(event, set)
		}
		set.add(handler)
		try {
			this.ensureRootListener(event)
		} catch (error) {
			set.delete(handler)
			if (set.size === 0) {
				this.eventHandlers.delete(event)
			}
			throw error
		}
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const set = this.eventHandlers.get(event)
		if (!set) {
			return
		}
		const removed = set.delete(handler)
		if (set.size === 0) {
			// Also detach the fan-out listener installed by `ensureRootListener`.
			const rootHandler = this.rootEventHandlers.get(event)
			if (rootHandler) {
				try {
					this.externalSession.off(event, rootHandler)
				} catch (error) {
					if (removed) {
						set.add(handler)
					}
					throw error
				}
			}
			this.eventHandlers.delete(event)
			this.rootEventHandlers.delete(event)
		}
	}

	async close(): Promise<void> {
		if (this.closePromise) {
			return this.closePromise
		}
		let resolveOperation!: () => void
		let rejectOperation!: (error: unknown) => void
		const operation = new Promise<void>((resolve, reject) => {
			resolveOperation = resolve
			rejectOperation = reject
		})
		this.closePromise = operation
		const ownsSession = this.ownsExternalSession()
		const why = "connection closed"
		const closeHandlers = this.enterTerminalState(why)
		this.releaseRetainedState()
		if (closeHandlers) {
			this.emitTransportClosed(closeHandlers, why)
		}
		void (async () => {
			try {
				if (ownsSession) {
					await this.externalSession.close?.()
				}
				this.releaseExternalOwnership(true)
				resolveOperation()
			} catch (error) {
				if (this.closePromise === operation) {
					this.closePromise = null
				}
				try {
					if (
						getOwnership(this.externalSession, SESSION_OWNED) ===
						ABANDONED_OWNER
					) {
						deleteOwnership(this.externalSession, SESSION_OWNED)
					}
				} catch {}
				rejectOperation(error)
			}
		})()
		return operation
	}

	abandonOwnership(): void {
		const why = "connection abandoned after cleanup failure"
		const closeHandlers = this.enterTerminalState(why)
		this.releaseRetainedState()
		try {
			if (getOwnership(this.externalSession, SESSION_OWNED) === this) {
				if (this.closePromise) {
					setOwnership(this.externalSession, SESSION_OWNED, ABANDONED_OWNER)
				} else {
					deleteOwnership(this.externalSession, SESSION_OWNED)
				}
			}
		} catch {}
		if (closeHandlers) {
			this.emitTransportClosed(closeHandlers, why)
		}
	}

	getSession(sessionId: string): CDPSessionLike | undefined {
		return this.sessions.get(sessionId)
	}

	protected _createSession(sessionId: string): CDPSessionLike {
		return new ExternalSessionAdapter(this, sessionId)
	}

	protected _setSession(sessionId: string, session: CDPSessionLike): void {
		this.sessions.set(sessionId, session)
	}

	protected _mapTarget(sessionId: string, targetId: string): void {
		this.sessionToTarget.set(sessionId, targetId)
	}

	protected _closedError(): Error | null {
		return this.closeReason
			? new CDPConnectionClosedError(this.closeReason)
			: null
	}

	protected _sendTargetAttach(
		targetId: string,
		signal: AbortSignal | undefined,
		lateResult: LateResultCallbacks<CDPCommandResult<"Target.attachToTarget">>,
	): Promise<CDPCommandResult<"Target.attachToTarget">> {
		const params = { targetId, flatten: true }
		return signal
			? this.sendInternal("Target.attachToTarget", signal, lateResult, params)
			: this.send("Target.attachToTarget", params)
	}

	onTransportClosed(handler: (why: string) => void): void {
		if (this.closeReason) {
			try {
				handler(this.closeReason)
			} catch {}
			return
		}
		this.transportCloseHandlers.add(handler)
	}

	offTransportClosed(handler: (why: string) => void): void {
		this.transportCloseHandlers.delete(handler)
	}

	protected _detachUnclaimedSession(sessionId: string, targetId: string): void {
		if (this.closeReason || this.unclaimedAttachSessions.has(sessionId)) {
			return
		}
		this.cleanupChildSession(sessionId, targetId, false)
		this.unclaimedAttachSessions.set(sessionId, targetId)
		const controller = new AbortController()
		const timer = setTimeout(
			() => controller.abort(new Error("Unclaimed target detach timed out")),
			1000,
		)
		unrefTimer(timer)
		void this.sendWithSignal("Target.detachFromTarget", controller.signal, {
			sessionId,
		})
			.catch(() => {})
			.finally(() => clearTimeout(timer))
	}

	_rejectSessionDispatch<M extends CDPCommand>(
		sessionId: string,
		method: M,
		error: Error,
		...params: CDPCommandParams<M>
	): void {
		this.settleSessionDispatch(sessionId, method, params[0], error)
	}
}
