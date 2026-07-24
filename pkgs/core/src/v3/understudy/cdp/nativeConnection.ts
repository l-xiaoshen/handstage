import type { Protocol } from "devtools-protocol"
import { HANDSTAGE_VERSION } from "../../../version"
import {
	CDPConnectionClosedError,
	HandstageTransportAlreadyOwnedError,
	PageNotFoundError,
} from "../../types/public/sdkErrors"
import { unrefTimer } from "../abortUtils"
import { errorMessage } from "../protocolError"
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
	setOwnership,
	TRANSPORT_OWNED,
} from "./ownership"
import type {
	CDPAnyCommandParams,
	CDPAnyCommandResult,
	CDPAnyEventParams,
	CDPCommand,
	CDPCommandParams,
	CDPCommandResult,
	CDPEvent,
	CDPEventParams,
	CDPQueuedCommand,
} from "./protocol"
import { CDPSession } from "./sessions"
import { type CDPTransport, createWebSocketTransport } from "./transport"

const CLOSED_TRANSPORT: CDPTransport = Object.freeze({
	send: () => {},
	close: () => {},
})

// Bun and recent server runtimes accept connection options that are not yet in
// the DOM WebSocket constructor type.
const RuntimeWebSocket = WebSocket as typeof WebSocket & {
	new (
		url: string | URL,
		options: { headers: Record<string, string> },
	): WebSocket
}

type Inflight = {
	resolve: (value: CDPAnyCommandResult) => void
	reject: (e: Error) => void
	sessionId?: string | null
	method: string
	params?: CDPAnyCommandParams
	stack?: string
	ts: number
	cleanup?: () => void
}

type RawResponseMessage = {
	id: number
	result?: CDPAnyCommandResult
	error?: { code: number; message: string; data?: unknown }
	sessionId?: string
}

type RawEventMessage<E extends CDPEvent = CDPEvent> = E extends CDPEvent
	? {
			method: E
			params: CDPEventParams<E>
			sessionId?: string
		}
	: never

type RawMessage = RawResponseMessage | RawEventMessage

function parseRawMessage(json: string): RawMessage {
	const parsed = JSON.parse(json) as unknown
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("CDP message must be an object")
	}

	const record = parsed as Record<string, unknown>
	if ("id" in record) {
		if (typeof record.id !== "number") {
			throw new Error("CDP response id must be a number")
		}
		if (record.error !== undefined) {
			if (typeof record.error !== "object" || record.error === null) {
				throw new Error("CDP response error must be an object")
			}
			const responseError = record.error as Record<string, unknown>
			if (
				typeof responseError.code !== "number" ||
				typeof responseError.message !== "string"
			) {
				throw new Error("CDP response error is malformed")
			}
		}
	} else if (typeof record.method !== "string" || !("params" in record)) {
		throw new Error("CDP event must include method and params")
	}
	if (record.sessionId !== undefined && typeof record.sessionId !== "string") {
		throw new Error("CDP sessionId must be a string")
	}

	return parsed as RawMessage
}

export class CDPConnection extends BaseCDPConnection<CDPSession> {
	private transport: CDPTransport
	private nextId = 1
	private inflight = new Map<number, Inflight>() // Outstanding request records; `_sendViaSession()` inserts and `onMessage()` removes/resolves them.
	private eventHandlers = new Map<string, Set<EventHandler>>()
	private sessions = new Map<string, CDPSession>()
	/** Maps sessionId -> targetId (1:1 mapping) */
	private sessionToTarget = new Map<string, string>()
	private unclaimedAttachSessions = new Map<string, string>()
	private lateResponses = new Map<number, LateResponseHandler>()
	public readonly id: string | null = null // root
	private transportCloseHandlers = new Set<(why: string) => void>()
	private _isClosed = false
	private _closeReason: string | null = null
	private _closePromise: Promise<void> | null = null
	private readonly transportOnMessage = (data: string): void => {
		this.onMessage(data)
	}
	private readonly transportOnClose = (reason: string): void => {
		this.terminateFromTransport(
			`transport-close reason=${String(reason || "")}`,
			false,
		)
	}
	private readonly transportOnError = (err: Error): void => {
		this.terminateFromTransport(
			`transport-error ${err?.message ?? String(err)}`,
			true,
		)
	}

	public onTransportClosed(handler: (why: string) => void): void {
		if (this._closeReason) {
			try {
				handler(this._closeReason)
			} catch {}
			return
		}
		this.transportCloseHandlers.add(handler)
	}
	public offTransportClosed(handler: (why: string) => void): void {
		this.transportCloseHandlers.delete(handler)
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
		if (this._closeReason) {
			return null
		}
		this._closeReason = why
		this._isClosed = true
		this.resetAutoAttach()
		this.rejectAllInflight(why)
		const handlers = new Set(this.transportCloseHandlers)
		this.clearRetainedState()
		return handlers
	}

	private terminateFromTransport(why: string, closeTransport: boolean): void {
		const transport = this.transport
		const handlers = this.enterTerminalState(why)
		if (!handlers) {
			return
		}

		if (closeTransport) {
			const operation = Promise.resolve().then(async () => {
				await transport.close()
			})
			this._closePromise = operation
			void operation.then(
				() => {
					this.releaseTransportOwnership(transport, true)
					if (this.transport === transport) {
						this.transport = CLOSED_TRANSPORT
					}
				},
				() => {
					if (this._closePromise === operation) {
						this._closePromise = null
					}
				},
			)
		} else {
			this.releaseTransportOwnership(transport, true)
			if (this.transport === transport) {
				this.transport = CLOSED_TRANSPORT
			}
		}
		this.emitTransportClosed(handlers, why)
	}

	private clearRetainedState(): void {
		this.eventHandlers.clear()
		this.sessions.clear()
		this.sessionToTarget.clear()
		this.pendingAttaches.clear()
		this.unclaimedAttachSessions.clear()
		for (const late of this.lateResponses.values()) {
			late.handle = undefined
			late.settled = undefined
		}
		this.lateResponses.clear()
		this.transportCloseHandlers.clear()
		try {
			if (this.transport.onmessage === this.transportOnMessage) {
				this.transport.onmessage = undefined
			}
		} catch {}
		try {
			if (this.transport.onclose === this.transportOnClose) {
				this.transport.onclose = undefined
			}
		} catch {}
		try {
			if (this.transport.onerror === this.transportOnError) {
				this.transport.onerror = undefined
			}
		} catch {}
	}

	private ownsTransport(): boolean {
		return getOwnership(this.transport, TRANSPORT_OWNED) === this
	}

	private releaseTransportOwnership(
		transport = this.transport,
		includeAbandoned = false,
	): void {
		try {
			if (
				getOwnership(transport, TRANSPORT_OWNED) === this ||
				(includeAbandoned &&
					getOwnership(transport, TRANSPORT_OWNED) === ABANDONED_OWNER)
			) {
				deleteOwnership(transport, TRANSPORT_OWNED)
			}
		} catch {}
	}

	private retainLateResponse(
		id: number,
		handle: ((result: CDPAnyCommandResult) => void | Promise<void>) | undefined,
		settled: (() => void) | undefined,
		sessionId: string | null,
	): void {
		this.lateResponses.set(id, { handle, settled, sessionId })
	}

	private forgetLateResponse(id: number): void {
		const late = this.lateResponses.get(id)
		if (!late) {
			return
		}
		this.lateResponses.delete(id)
		const settled = late.settled
		late.handle = undefined
		late.settled = undefined
		try {
			settled?.()
		} catch {}
	}

	private dispatchLateResponse(message: RawResponseMessage): boolean {
		const late = this.lateResponses.get(message.id)
		if (!late) {
			return false
		}
		this.lateResponses.delete(message.id)
		const handle = late.handle
		const settled = late.settled
		late.handle = undefined
		late.settled = undefined
		if (!message.error && message.result !== undefined && handle) {
			try {
				const result = handle(message.result)
				void Promise.resolve(result).catch(() => {})
			} catch {}
		}
		try {
			settled?.()
		} catch {}
		return true
	}

	constructor(transport: CDPTransport) {
		super()
		const owned = getOwnership(transport, TRANSPORT_OWNED)
		if (owned) {
			throw new HandstageTransportAlreadyOwnedError("transport")
		}
		this.transport = transport
		try {
			setOwnership(transport, TRANSPORT_OWNED, this)
			this.transport.onclose = this.transportOnClose
			this.transport.onerror = this.transportOnError
			this.transport.onmessage = this.transportOnMessage
		} catch (error) {
			this.clearRetainedState()
			this.releaseTransportOwnership()
			throw error
		}
	}

	static async connect(
		wsUrl: string,
		options?: {
			headers?: Record<string, string>
			signal?: AbortSignal
			timeoutMs?: number
		},
	): Promise<CDPConnection> {
		// Include User-Agent header for server-side observability and version tracking
		// Merge user-provided headers, letting them override defaults
		const headers = {
			"User-Agent": `Handstage/${HANDSTAGE_VERSION}`,
			...options?.headers,
		}
		const ws = new RuntimeWebSocket(wsUrl, { headers })
		await new Promise<void>((resolve, reject) => {
			let settled = false
			const timeoutMs = options?.timeoutMs ?? 30_000
			let timer: ReturnType<typeof setTimeout> | null = null
			const cleanup = () => {
				ws.removeEventListener("open", onOpen)
				ws.removeEventListener("error", onError)
				ws.removeEventListener("close", onClose)
				options?.signal?.removeEventListener("abort", onAbort)
				if (timer) {
					clearTimeout(timer)
					timer = null
				}
			}
			const onOpen = () => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				resolve()
			}
			const onError = () => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				try {
					ws.close()
				} catch {}
				reject(new Error("WebSocket error"))
			}
			const onClose = (event: CloseEvent) => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				reject(
					new Error(
						`WebSocket closed before opening (code=${event.code} reason=${event.reason})`,
					),
				)
			}
			const failAndClose = (error: Error) => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				try {
					ws.close()
				} catch {}
				reject(error)
			}
			const onAbort = () => {
				failAndClose(
					options?.signal?.reason instanceof Error
						? options.signal.reason
						: new Error("WebSocket connection aborted"),
				)
			}
			ws.addEventListener("open", onOpen)
			ws.addEventListener("error", onError)
			ws.addEventListener("close", onClose)
			options?.signal?.addEventListener("abort", onAbort, { once: true })
			if (options?.signal?.aborted) {
				onAbort()
				return
			}
			if (Number.isFinite(timeoutMs)) {
				timer = setTimeout(
					() =>
						failAndClose(
							new Error(
								`WebSocket connection timed out after ${Math.max(0, timeoutMs)}ms`,
							),
						),
					Math.max(0, timeoutMs),
				)
			}
		})
		return new CDPConnection(createWebSocketTransport(ws))
	}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendRoot(method, undefined, undefined, ...params)
	}

	sendWithSignal<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendRoot(method, signal, undefined, ...params)
	}

	sendWithSignalAndLateResult<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		onLateResult: (result: CDPCommandResult<M>) => void | Promise<void>,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendRoot(method, signal, { handle: onLateResult }, ...params)
	}

	private sendRoot<M extends CDPCommand>(
		method: M,
		signal: AbortSignal | undefined,
		lateResult: LateResultCallbacks<CDPCommandResult<M>> | undefined,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		if (this._isClosed) {
			const error = new CDPConnectionClosedError(
				`Cannot send ${method}: connection is closed`,
			)
			return Promise.reject(error)
		}
		if (signal?.aborted) {
			const error =
				signal.reason instanceof Error
					? signal.reason
					: new Error("CDP command aborted")
			return Promise.reject(error)
		}
		const id = this.nextId++
		const requestParams = params[0]
		const payload = { id, method, params: requestParams }
		const stack = new Error().stack?.split("\n").slice(1, 4).join("\n")
		const p = new Promise<CDPCommandResult<M>>((resolve, reject) => {
			this.inflight.set(id, {
				resolve: (value) => resolve(value),
				reject,
				sessionId: null,
				method,
				params: requestParams,
				stack,
				ts: Date.now(),
			})
		})
		let dispatched = false
		if (signal) {
			const onAbort = () => {
				const entry = this.inflight.get(id)
				if (!entry) {
					return
				}
				this.inflight.delete(id)
				entry.cleanup?.()
				if (lateResult && dispatched) {
					try {
						lateResult.retained?.()
					} catch {}
					this.retainLateResponse(
						id,
						lateResult.handle as (
							result: CDPAnyCommandResult,
						) => void | Promise<void>,
						lateResult.settled,
						null,
					)
				}
				entry.reject(
					signal.reason instanceof Error
						? signal.reason
						: new Error("CDP command aborted"),
				)
			}
			const entry = this.inflight.get(id)
			if (entry) {
				entry.cleanup = () => signal.removeEventListener("abort", onAbort)
				signal.addEventListener("abort", onAbort, { once: true })
				if (signal.aborted) {
					onAbort()
					return p
				}
			}
		}
		// Prevent unhandledRejection if a session detaches before the caller awaits.
		void p.catch(() => {})
		try {
			dispatched = true
			this.transport.send(JSON.stringify(payload))
		} catch (error) {
			dispatched = false
			this.forgetLateResponse(id)
			const sendError =
				error instanceof Error ? error : new Error(String(error))
			const entry = this.inflight.get(id)
			this.inflight.delete(id)
			entry?.cleanup?.()
			entry?.reject(sendError)
		}
		return p
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		if (this._isClosed) {
			throw new CDPConnectionClosedError("connection is closed")
		}
		const set = this.eventHandlers.get(event) ?? new Set<EventHandler>()
		set.add(handler)
		this.eventHandlers.set(event, set)
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const set = this.eventHandlers.get(event)
		if (!set) {
			return
		}
		set.delete(handler)
		if (set.size === 0) {
			this.eventHandlers.delete(event)
		}
	}

	async close(): Promise<void> {
		if (this._closePromise) {
			return this._closePromise
		}

		let resolveOperation!: () => void
		let rejectOperation!: (error: unknown) => void
		const operation = new Promise<void>((resolve, reject) => {
			resolveOperation = resolve
			rejectOperation = reject
		})
		this._closePromise = operation
		const transport = this.transport
		const ownsTransport = this.ownsTransport()
		const closeHandlers = this.enterTerminalState("connection closed")
		if (closeHandlers) {
			this.emitTransportClosed(closeHandlers, "connection closed")
		}
		void (async () => {
			try {
				if (ownsTransport) {
					await transport.close()
				}
				this.clearRetainedState()
				this.releaseTransportOwnership(transport, true)
				if (this.transport === transport) {
					this.transport = CLOSED_TRANSPORT
				}
				resolveOperation()
			} catch (error) {
				if (this._closePromise === operation) {
					this._closePromise = null
				}
				this.clearRetainedState()
				try {
					if (getOwnership(transport, TRANSPORT_OWNED) === ABANDONED_OWNER) {
						deleteOwnership(transport, TRANSPORT_OWNED)
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
		const transport = this.transport
		try {
			if (getOwnership(transport, TRANSPORT_OWNED) === this) {
				if (this._closePromise) {
					setOwnership(transport, TRANSPORT_OWNED, ABANDONED_OWNER)
				} else {
					deleteOwnership(transport, TRANSPORT_OWNED)
				}
			}
		} catch {}
		if (this.transport === transport) {
			this.transport = CLOSED_TRANSPORT
		}
		if (closeHandlers) {
			this.emitTransportClosed(closeHandlers, why)
		}
	}

	private rejectAllInflight(why: string): void {
		for (const [id, entry] of this.inflight.entries()) {
			entry.cleanup?.()
			entry.reject(new CDPConnectionClosedError(why))
			this.inflight.delete(id)
		}
		this.rejectAllSessionDispatches(new CDPConnectionClosedError(why))
	}

	getSession(sessionId: string): CDPSession | undefined {
		return this.sessions.get(sessionId)
	}

	override async getTargets(
		signal?: AbortSignal,
	): Promise<Protocol.Target.TargetInfo[]> {
		const res = signal
			? await this.sendWithSignal("Target.getTargets", signal)
			: await this.send("Target.getTargets")
		return res.targetInfos
	}

	protected _createSession(sessionId: string): CDPSession {
		return new CDPSession(this, sessionId)
	}

	protected _setSession(sessionId: string, session: CDPSession): void {
		this.sessions.set(sessionId, session)
	}

	protected _mapTarget(sessionId: string, targetId: string): void {
		this.sessionToTarget.set(sessionId, targetId)
	}

	protected _closedError(): Error | null {
		return this._isClosed
			? new CDPConnectionClosedError("connection is closed")
			: null
	}

	protected _sendTargetAttach(
		targetId: string,
		signal: AbortSignal | undefined,
		lateResult: LateResultCallbacks<CDPCommandResult<"Target.attachToTarget">>,
	): Promise<CDPCommandResult<"Target.attachToTarget">> {
		const params = { targetId, flatten: true }
		return signal
			? this.sendRoot("Target.attachToTarget", signal, lateResult, params)
			: this.send("Target.attachToTarget", params)
	}

	private cleanupSession(
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
		for (const [id, entry] of this.inflight.entries()) {
			if (entry.sessionId !== sessionId) {
				continue
			}
			entry.reject(
				new PageNotFoundError(
					`target closed before CDP response (sessionId=${sessionId}, targetId=${targetId ?? "unknown"})`,
				),
			)
			entry.cleanup?.()
			this.inflight.delete(id)
		}
		for (const [id, late] of this.lateResponses.entries()) {
			if (late.sessionId === sessionId) {
				this.forgetLateResponse(id)
			}
		}
		this.rejectSessionDispatchesForSession(
			sessionId,
			new PageNotFoundError(
				`target closed before CDP send (sessionId=${sessionId}, targetId=${targetId ?? "unknown"})`,
			),
		)
		this.sessions.delete(sessionId)
		this.sessionToTarget.delete(sessionId)
		for (const key of [...this.eventHandlers.keys()]) {
			if (key.startsWith(`${sessionId}:`)) {
				this.eventHandlers.delete(key)
			}
		}
	}

	protected _detachUnclaimedSession(sessionId: string, targetId: string): void {
		if (this._isClosed || this.unclaimedAttachSessions.has(sessionId)) {
			return
		}
		this.cleanupSession(sessionId, targetId, false)
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

	private onMessage(json: string): void {
		if (this._isClosed) {
			return
		}

		let msg: RawMessage
		try {
			msg = parseRawMessage(json)
		} catch (error) {
			const detail = errorMessage(error)
			this.terminateFromTransport(`transport-protocol-error ${detail}`, true)
			return
		}

		try {
			if ("id" in msg) {
				const rec = this.inflight.get(msg.id)
				if (!rec) {
					this.dispatchLateResponse(msg)
					return
				}

				this.inflight.delete(msg.id)
				rec.cleanup?.()

				if (msg.error) {
					rec.reject(new Error(`${msg.error.code} ${msg.error.message}`))
				} else {
					rec.resolve(msg.result)
				}
				return
			}

			if (msg.method === "Target.attachedToTarget") {
				const { params } = msg
				if (this.unclaimedAttachSessions.has(params.sessionId)) {
					this.cleanupSession(
						params.sessionId,
						params.targetInfo.targetId,
						false,
					)
					return
				}
				if (!this.sessions.has(params.sessionId)) {
					this.sessions.set(
						params.sessionId,
						new CDPSession(this, params.sessionId),
					)
				}
				this.sessionToTarget.set(params.sessionId, params.targetInfo.targetId)
			} else if (msg.method === "Target.detachedFromTarget") {
				const { params } = msg
				this.cleanupSession(params.sessionId, params.targetId)
				this.unclaimedAttachSessions.delete(params.sessionId)
			} else if (msg.method === "Target.targetDestroyed") {
				const { params } = msg
				for (const pending of this.pendingAttaches) {
					if (pending.targetId === params.targetId) {
						pending.targetDestroyed = true
					}
				}
				for (const [sessionId, targetId] of [
					...this.sessionToTarget.entries(),
				]) {
					if (targetId === params.targetId) {
						this.cleanupSession(sessionId, params.targetId)
					}
				}
				for (const [sessionId, targetId] of this.unclaimedAttachSessions) {
					if (targetId === params.targetId) {
						this.unclaimedAttachSessions.delete(sessionId)
					}
				}
			}

			const { method, params, sessionId } = msg

			if (sessionId) {
				const session = this.sessions.get(sessionId)
				session?.dispatch(method, params)

				// Forward target lifecycle events to root listeners as well.
				// Some browsers emit these via a parent session rather than the root
				// connection; fan-out keeps target tracking consistent.
				if (method.startsWith("Target.")) {
					const handlers = this.eventHandlers.get(method)
					if (handlers) {
						for (const h of handlers) {
							invokeEventHandler(h, params)
						}
					}
				}
				return
			}

			const handlers = this.eventHandlers.get(method)
			if (handlers) {
				for (const h of handlers) {
					invokeEventHandler(h, params)
				}
			}
		} catch (error) {
			if (this._isClosed) {
				return
			}
			const detail = errorMessage(error)
			this.terminateFromTransport(`transport-protocol-error ${detail}`, true)
		}
	}

	_sendViaSession<M extends CDPCommand>(
		sessionId: string,
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendViaSession(
			sessionId,
			method,
			undefined,
			undefined,
			undefined,
			...params,
		)
	}

	_sendViaSessionWithSignal<M extends CDPCommand>(
		sessionId: string,
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendViaSession(
			sessionId,
			method,
			signal,
			undefined,
			undefined,
			...params,
		)
	}

	_sendViaSessionWithSignalAndLateResult<M extends CDPCommand>(
		sessionId: string,
		method: M,
		signal: AbortSignal,
		onLateResult: (result: CDPCommandResult<M>) => void | Promise<void>,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendViaSession(
			sessionId,
			method,
			signal,
			undefined,
			onLateResult as (result: CDPAnyCommandResult) => void | Promise<void>,
			...params,
		)
	}

	_sendViaSessionQueued<M extends CDPCommand>(
		sessionId: string,
		method: M,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>> {
		let resolveDispatch!: () => void
		let rejectDispatch!: (error: Error) => void
		const dispatched = new Promise<void>((resolve, reject) => {
			resolveDispatch = resolve
			rejectDispatch = reject
		})
		const response = this.sendViaSession(
			sessionId,
			method,
			undefined,
			{ resolve: resolveDispatch, reject: rejectDispatch },
			undefined,
			...params,
		)
		return { dispatched, response }
	}

	_sendViaSessionQueuedWithSignal<M extends CDPCommand>(
		sessionId: string,
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>> {
		let resolveDispatch!: () => void
		let rejectDispatch!: (error: Error) => void
		const dispatched = new Promise<void>((resolve, reject) => {
			resolveDispatch = resolve
			rejectDispatch = reject
		})
		const response = this.sendViaSession(
			sessionId,
			method,
			signal,
			{ resolve: resolveDispatch, reject: rejectDispatch },
			undefined,
			...params,
		)
		return { dispatched, response }
	}

	private sendViaSession<M extends CDPCommand>(
		sessionId: string,
		method: M,
		signal: AbortSignal | undefined,
		dispatch:
			| { resolve: () => void; reject: (error: Error) => void }
			| undefined,
		onLateResult:
			| ((result: CDPAnyCommandResult) => void | Promise<void>)
			| undefined,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		if (this._isClosed) {
			const error = new CDPConnectionClosedError(
				`Cannot send ${method}: connection is closed`,
			)
			dispatch?.reject(error)
			return Promise.reject(error)
		}
		if (signal?.aborted) {
			const error =
				signal.reason instanceof Error
					? signal.reason
					: new Error("CDP command aborted")
			dispatch?.reject(error)
			return Promise.reject(error)
		}
		const id = this.nextId++
		const requestParams = params[0]
		const payload = { id, method, params: requestParams, sessionId }
		const stack = new Error().stack?.split("\n").slice(1, 4).join("\n")
		const p = new Promise<CDPCommandResult<M>>((resolve, reject) => {
			this.inflight.set(id, {
				resolve: (value) => resolve(value),
				reject,
				sessionId,
				method,
				params: requestParams,
				stack,
				ts: Date.now(),
			})
		})
		let dispatched = false
		if (signal) {
			const onAbort = () => {
				const error =
					signal.reason instanceof Error
						? signal.reason
						: new Error("CDP command aborted")
				dispatch?.reject(error)
				const entry = this.inflight.get(id)
				if (!entry) {
					return
				}
				this.inflight.delete(id)
				entry.cleanup?.()
				if (onLateResult && dispatched) {
					this.retainLateResponse(id, onLateResult, undefined, sessionId)
				}
				entry.reject(error)
			}
			const entry = this.inflight.get(id)
			if (entry) {
				entry.cleanup = () => signal.removeEventListener("abort", onAbort)
				signal.addEventListener("abort", onAbort, { once: true })
				if (signal.aborted) {
					onAbort()
					return p
				}
			}
		}
		// Prevent unhandledRejection if a session detaches before the caller awaits.
		void p.catch(() => {})
		try {
			dispatched = true
			this.transport.send(JSON.stringify(payload))
			dispatch?.resolve()
			this.settleSessionDispatch(sessionId, method, requestParams)
		} catch (error) {
			dispatched = false
			this.forgetLateResponse(id)
			const sendError =
				error instanceof Error ? error : new Error(String(error))
			dispatch?.reject(sendError)
			const entry = this.inflight.get(id)
			this.inflight.delete(id)
			entry?.cleanup?.()
			entry?.reject(sendError)
			this.settleSessionDispatch(sessionId, method, requestParams, sendError)
		}
		return p
	}

	_onSessionEvent<E extends CDPEvent>(
		sessionId: string,
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		if (this._isClosed) {
			throw new CDPConnectionClosedError("connection is closed")
		}
		const key = `${sessionId}:${event}`
		const set = this.eventHandlers.get(key) ?? new Set<EventHandler>()
		set.add(handler)
		this.eventHandlers.set(key, set)
	}

	_offSessionEvent<E extends CDPEvent>(
		sessionId: string,
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const key = `${sessionId}:${event}`
		const set = this.eventHandlers.get(key)
		if (!set) {
			return
		}
		set.delete(handler)
		// Drop the bucket once empty so a long-lived connection doesn't
		// accumulate stale `${sessionId}:Event` keys after sessions detach.
		if (set.size === 0) {
			this.eventHandlers.delete(key)
		}
	}

	_dispatchToSession(
		sessionId: string,
		event: CDPEvent,
		params: CDPAnyEventParams,
	): void {
		const key = `${sessionId}:${event}`
		const handlers = this.eventHandlers.get(key)
		if (handlers) {
			for (const h of handlers) {
				invokeEventHandler(h, params)
			}
		}
	}
}
