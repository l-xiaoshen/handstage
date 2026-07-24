import type { Protocol } from "devtools-protocol"
import { PageNotFoundError } from "../../types/public/sdkErrors"
import { abortError } from "../abortUtils"
import type {
	LateResultCallbacks,
	PendingTargetAttach,
	SessionDispatchWaiter,
} from "./internal"
import {
	type CDPCommand,
	type CDPCommandParams,
	type CDPCommandResult,
	type CDPConnectionLike,
	type CDPEvent,
	type CDPEventParams,
	type CDPSessionLike,
	sendCDPWithSignal,
} from "./protocol"

export abstract class BaseCDPConnection<
	TSession extends CDPSessionLike = CDPSessionLike,
> implements CDPConnectionLike
{
	abstract send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>>
	abstract on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	abstract off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	abstract close(): Promise<void>
	abstract get id(): string | null
	abstract getSession(sessionId: string): TSession | undefined
	abstract onTransportClosed(handler: (why: string) => void): void
	abstract offTransportClosed(handler: (why: string) => void): void
	protected readonly pendingAttaches = new Set<PendingTargetAttach>()
	private readonly sessionDispatchWaiters = new Set<SessionDispatchWaiter>()

	// Memoize the in-flight enable so concurrent Contexts sharing the
	// connection don't all re-fire setAutoAttach on the browser session.
	// On rejection we clear the memo so the next caller can retry —
	// otherwise a partial failure (e.g. setAutoAttach succeeds but
	// setDiscoverTargets times out) would permanently leave the
	// connection in a half-initialized state.
	private _autoAttachPromise: Promise<void> | null = null
	private _autoAttachSignal: AbortSignal | undefined

	waitForSessionDispatch<M extends CDPCommand>(
		sessionId: string,
		method: M,
		...params: CDPCommandParams<M>
	): Promise<void> {
		return this.waitForSessionDispatchInternal(
			sessionId,
			method,
			undefined,
			...params,
		)
	}

	waitForSessionDispatchWithSignal<M extends CDPCommand>(
		sessionId: string,
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<void> {
		return this.waitForSessionDispatchInternal(
			sessionId,
			method,
			signal,
			...params,
		)
	}

	private waitForSessionDispatchInternal<M extends CDPCommand>(
		sessionId: string,
		method: M,
		signal: AbortSignal | undefined,
		...params: CDPCommandParams<M>
	): Promise<void> {
		const closedError = this._closedError()
		if (closedError) {
			return Promise.reject(closedError)
		}
		if (signal?.aborted) {
			return Promise.reject(abortError(signal, "CDP dispatch wait aborted"))
		}

		return new Promise<void>((resolve, reject) => {
			const waiter: SessionDispatchWaiter = {
				sessionId,
				method,
				params: params[0],
				resolve: () => {
					this.sessionDispatchWaiters.delete(waiter)
					waiter.cleanup?.()
					resolve()
				},
				reject: (error: Error) => {
					this.sessionDispatchWaiters.delete(waiter)
					waiter.cleanup?.()
					reject(error)
				},
			}
			this.sessionDispatchWaiters.add(waiter)
			if (signal) {
				const onAbort = () =>
					waiter.reject(abortError(signal, "CDP dispatch wait aborted"))
				waiter.cleanup = () => signal.removeEventListener("abort", onAbort)
				signal.addEventListener("abort", onAbort, { once: true })
				if (signal.aborted) {
					onAbort()
				}
			}
		})
	}

	enableAutoAttach(signal?: AbortSignal): Promise<void> {
		const existing = this._autoAttachPromise
		if (existing && this._autoAttachSignal?.aborted) {
			return existing.then(
				() => {},
				() => {
					if (signal?.aborted) {
						throw signal.reason instanceof Error
							? signal.reason
							: new Error("Auto-attach startup aborted")
					}
					if (this._autoAttachPromise === existing) {
						this._autoAttachPromise = null
						this._autoAttachSignal = undefined
					}
					return this.enableAutoAttach(signal)
				},
			)
		}
		if (this._autoAttachPromise) {
			return this._autoAttachPromise
		}
		const p = (async () => {
			let autoAttachEnabled = false
			try {
				const autoAttachParams = {
					autoAttach: true,
					flatten: true,
					waitForDebuggerOnStart: true,
				}
				if (signal) {
					await sendCDPWithSignal(
						this,
						"Target.setAutoAttach",
						signal,
						autoAttachParams,
					)
				} else {
					await this.send("Target.setAutoAttach", autoAttachParams)
				}
				autoAttachEnabled = true
				if (signal) {
					await sendCDPWithSignal(this, "Target.setDiscoverTargets", signal, {
						discover: true,
					})
				} else {
					await this.send("Target.setDiscoverTargets", { discover: true })
				}
			} catch (error) {
				if (autoAttachEnabled) {
					const rollbackController = new AbortController()
					const timer = setTimeout(
						() =>
							rollbackController.abort(
								new Error("Target.setAutoAttach rollback timed out"),
							),
						1000,
					)
					try {
						await sendCDPWithSignal(
							this,
							"Target.setAutoAttach",
							rollbackController.signal,
							{
								autoAttach: false,
								flatten: true,
								waitForDebuggerOnStart: false,
							},
						)
					} catch {
					} finally {
						clearTimeout(timer)
					}
				}
				throw error
			}
		})()
		this._autoAttachPromise = p
		this._autoAttachSignal = signal
		void p.then(
			() => {
				if (this._autoAttachPromise === p) {
					this._autoAttachSignal = undefined
				}
			},
			() => {},
		)
		p.catch(() => {
			// Allow retry — but only clear if we still own this promise.
			if (this._autoAttachPromise === p) {
				this._autoAttachPromise = null
				this._autoAttachSignal = undefined
			}
		})
		return p
	}

	protected resetAutoAttach(): void {
		this._autoAttachPromise = null
		this._autoAttachSignal = undefined
	}

	async attachToTarget(
		targetId: string,
		signal?: AbortSignal,
	): Promise<TSession> {
		if (signal?.aborted) {
			throw abortError(signal, "CDP command aborted")
		}
		const pending: PendingTargetAttach = {
			targetId,
			detachedSessionIds: new Set(),
			targetDestroyed: false,
		}
		this.pendingAttaches.add(pending)
		let retainPending = false
		const detachLateSession = (sessionId: string): void => {
			if (
				pending.targetDestroyed ||
				pending.detachedSessionIds.has(sessionId)
			) {
				return
			}
			this._detachUnclaimedSession(sessionId, targetId)
		}

		try {
			const lateResult: LateResultCallbacks<
				CDPCommandResult<"Target.attachToTarget">
			> = {
				handle: (result) => detachLateSession(result.sessionId),
				retained: () => {
					retainPending = true
				},
				settled: () => this.pendingAttaches.delete(pending),
			}
			const { sessionId } = await this._sendTargetAttach(
				targetId,
				signal,
				lateResult,
			)
			if (signal?.aborted) {
				detachLateSession(sessionId)
				throw abortError(signal, "CDP command aborted")
			}
			const closedError = this._closedError()
			if (closedError) {
				throw closedError
			}
			if (
				pending.targetDestroyed ||
				pending.detachedSessionIds.has(sessionId)
			) {
				throw new PageNotFoundError(
					`target closed before attach completed (sessionId=${sessionId}, targetId=${targetId})`,
				)
			}

			let session = this.getSession(sessionId)
			if (!session) {
				session = this._createSession(sessionId)
				this._setSession(sessionId, session)
			}
			this._mapTarget(sessionId, targetId)
			return session
		} finally {
			if (!retainPending) {
				this.pendingAttaches.delete(pending)
			}
		}
	}

	async getTargets(
		signal?: AbortSignal,
	): Promise<Protocol.Target.TargetInfo[]> {
		const res = signal
			? await sendCDPWithSignal(this, "Target.getTargets", signal)
			: await this.send("Target.getTargets")
		return res.targetInfos
	}

	protected abstract _createSession(sessionId: string): TSession
	protected abstract _setSession(sessionId: string, session: TSession): void
	protected abstract _mapTarget(sessionId: string, targetId: string): void
	protected abstract _closedError(): Error | null
	protected abstract _sendTargetAttach(
		targetId: string,
		signal: AbortSignal | undefined,
		lateResult: LateResultCallbacks<CDPCommandResult<"Target.attachToTarget">>,
	): Promise<CDPCommandResult<"Target.attachToTarget">>
	protected abstract _detachUnclaimedSession(
		sessionId: string,
		targetId: string,
	): void

	protected rejectAllSessionDispatches(error: Error): void {
		for (const waiter of [...this.sessionDispatchWaiters]) {
			waiter.reject(error)
		}
	}

	protected rejectSessionDispatchesForSession(
		sessionId: string,
		error: Error,
	): void {
		for (const waiter of [...this.sessionDispatchWaiters]) {
			if (waiter.sessionId === sessionId) {
				waiter.reject(error)
			}
		}
	}

	protected settleSessionDispatch(
		sessionId: string,
		method: string,
		params: CDPCommandParams<CDPCommand>[0] | undefined,
		error?: Error,
	): void {
		for (const waiter of [...this.sessionDispatchWaiters]) {
			if (
				waiter.sessionId !== sessionId ||
				waiter.method !== method ||
				!Object.is(waiter.params, params)
			) {
				continue
			}
			if (error) {
				waiter.reject(error)
			} else {
				waiter.resolve()
			}
			return
		}
	}
}
