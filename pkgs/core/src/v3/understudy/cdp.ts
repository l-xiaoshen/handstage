import type { Protocol } from "devtools-protocol"
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping"
import { HANDSTAGE_VERSION } from "../../version"
import {
	CDPConnectionClosedError,
	HandstageTransportAlreadyOwnedError,
	PageNotFoundError,
} from "../types/public/sdkErrors"

/**
 * Marker placed on a `CDPTransport` once a `CDPConnection` has bound its
 * `onmessage` / `onclose` / `onerror` callbacks.  A second wrap throws so
 * the caller can't silently destroy the first owner.  Use `Symbol.for(...)`
 * so the marker survives across module realms (rare, but cheap to guard).
 */
const TRANSPORT_OWNED = Symbol.for("handstage.cdp.transportOwned")

/**
 * Same marker as {@link TRANSPORT_OWNED} but for `ExternalCDPSession`
 * wrapped by `ExternalConnectionAdapter`.
 */
const SESSION_OWNED = Symbol.for("handstage.cdp.sessionOwned")
const webSocketOwners = new WeakMap<WebSocket, CDPTransport>()

export type CDPCommand = Extract<keyof ProtocolMapping.Commands, string>
export type CDPEvent = Extract<keyof ProtocolMapping.Events, string>
export type CDPCommandParams<M extends CDPCommand> =
	ProtocolMapping.Commands[M]["paramsType"]
export type CDPCommandResult<M extends CDPCommand> =
	ProtocolMapping.Commands[M]["returnType"]
export type CDPEventParams<E extends CDPEvent> = ProtocolMapping.Events[E][0]
export type CDPAnyCommandParams = {
	[M in CDPCommand]: CDPCommandParams<M>[0]
}[CDPCommand]
export type CDPAnyCommandResult = {
	[M in CDPCommand]: CDPCommandResult<M>
}[CDPCommand]
export type CDPAnyEventParams = {
	[E in CDPEvent]: CDPEventParams<E>
}[CDPEvent]

export type CDPQueuedCommand<T> = {
	dispatched: Promise<void>
	response: Promise<T>
}

/**
 * CDP transport & session multiplexer
 *
 * Owns the browser WebSocket and multiplexes flattened Target sessions.
 * Tracks inflight CDP calls, routes responses to the right session, and forwards events.
 *
 * This does not interpret Page/DOM/Runtime semantics — callers own that logic.
 */
export interface CDPSessionLike {
	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>>
	sendWithSignal?<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>>
	sendQueued?<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>>
	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	close(): Promise<void>
	readonly id: string | null
}

export interface CDPTransport {
	send(message: string): void
	close(): void | Promise<void>
	onmessage?: (message: string) => void
	onclose?: (reason: string) => void
	onerror?: (error: Error) => void
}

export function createWebSocketTransport(ws: WebSocket): CDPTransport {
	if (webSocketOwners.has(ws)) {
		throw new HandstageTransportAlreadyOwnedError("websocket")
	}

	let cleaned = false
	const cleanup = () => {
		if (cleaned) return
		cleaned = true
		ws.removeEventListener("message", onMessage)
		ws.removeEventListener("close", onClose)
		ws.removeEventListener("error", onError)
		if (webSocketOwners.get(ws) === transport) webSocketOwners.delete(ws)
	}
	const onMessage = (event: MessageEvent) => {
		transport.onmessage?.(event.data.toString())
	}
	const onClose = (event: CloseEvent) => {
		try {
			transport.onclose?.(`code=${event.code} reason=${event.reason}`)
		} finally {
			cleanup()
		}
	}
	const onError = () => {
		try {
			transport.onerror?.(new Error("WebSocket error"))
		} finally {
			cleanup()
			try {
				ws.close()
			} catch {}
		}
	}
	const transport: CDPTransport = {
		send: (message) => ws.send(message),
		close: () => {
			cleanup()
			ws.close()
		},
	}

	webSocketOwners.set(ws, transport)
	ws.addEventListener("message", onMessage)
	ws.addEventListener("close", onClose)
	ws.addEventListener("error", onError)
	return transport
}

export interface ExternalCDPSession {
	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>>
	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	onclose?: (reason: string) => void
	close?(): Promise<void>
	readonly id: string | null
}

export interface CDPConnectionLike extends CDPSessionLike {
	getSession(sessionId: string): CDPSessionLike | undefined
	enableAutoAttach(): Promise<void>
	attachToTarget(targetId: string): Promise<CDPSessionLike>
	getTargets(): Promise<Protocol.Target.TargetInfo[]>
	onTransportClosed(handler: (why: string) => void): void
	offTransportClosed(handler: (why: string) => void): void
	waitForSessionDispatch<M extends CDPCommand>(
		sessionId: string,
		method: M,
		...params: CDPCommandParams<M>
	): Promise<void>
}

export function sendCDPWithSignal<M extends CDPCommand>(
	session: CDPSessionLike,
	method: M,
	signal: AbortSignal,
	...params: CDPCommandParams<M>
): Promise<CDPCommandResult<M>> {
	if (session.sendWithSignal) {
		return session.sendWithSignal(method, signal, ...params)
	}
	if (signal.aborted) {
		return Promise.reject(
			signal.reason instanceof Error
				? signal.reason
				: new Error("CDP command aborted"),
		)
	}
	return new Promise<CDPCommandResult<M>>((resolve, reject) => {
		const onAbort = () => {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error("CDP command aborted"),
			)
		}
		signal.addEventListener("abort", onAbort, { once: true })
		session.send(method, ...params).then(
			(result) => {
				signal.removeEventListener("abort", onAbort)
				resolve(result)
			},
			(error) => {
				signal.removeEventListener("abort", onAbort)
				reject(error)
			},
		)
	})
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

type EventHandlerResult = void | PromiseLike<void>
type EventHandler = (params: CDPAnyEventParams) => EventHandlerResult
type SessionDispatchWaiter = {
	sessionId: string
	method: string
	params?: CDPAnyCommandParams
	resolve: () => void
	reject: (error: Error) => void
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

function ignoreEventHandlerError(): void {}

function invokeEventHandler(
	handler: EventHandler,
	params: CDPAnyEventParams,
): void {
	try {
		const result = handler(params)
		if (result !== undefined) {
			void Promise.resolve(result).catch(ignoreEventHandlerError)
		}
	} catch {}
}

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
	abstract waitForSessionDispatch<M extends CDPCommand>(
		sessionId: string,
		method: M,
		...params: CDPCommandParams<M>
	): Promise<void>

	// Memoize the in-flight enable so concurrent Contexts sharing the
	// connection don't all re-fire setAutoAttach on the browser session.
	// On rejection we clear the memo so the next caller can retry —
	// otherwise a partial failure (e.g. setAutoAttach succeeds but
	// setDiscoverTargets times out) would permanently leave the
	// connection in a half-initialized state.
	private _autoAttachPromise: Promise<void> | null = null

	enableAutoAttach(): Promise<void> {
		if (this._autoAttachPromise) return this._autoAttachPromise
		const p = (async () => {
			await this.send("Target.setAutoAttach", {
				autoAttach: true,
				flatten: true,
				waitForDebuggerOnStart: true,
			})
			await this.send("Target.setDiscoverTargets", { discover: true })
		})()
		this._autoAttachPromise = p
		p.catch(() => {
			// Allow retry — but only clear if we still own this promise.
			if (this._autoAttachPromise === p) {
				this._autoAttachPromise = null
			}
		})
		return p
	}

	protected resetAutoAttach(): void {
		this._autoAttachPromise = null
	}

	async attachToTarget(targetId: string): Promise<TSession> {
		const { sessionId } = await this.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})

		let session = this.getSession(sessionId)
		if (!session) {
			session = this._createSession(sessionId)
			this._setSession(sessionId, session)
		}
		this._mapTarget(sessionId, targetId)
		return session
	}

	async getTargets(): Promise<Protocol.Target.TargetInfo[]> {
		const res = await this.send("Target.getTargets")
		return res.targetInfos
	}

	protected abstract _createSession(sessionId: string): TSession
	protected abstract _setSession(sessionId: string, session: TSession): void
	protected abstract _mapTarget(sessionId: string, targetId: string): void
}

export class CDPConnection extends BaseCDPConnection<CDPSession> {
	private transport: CDPTransport
	private nextId = 1
	private inflight = new Map<number, Inflight>() // Outstanding request records; `_sendViaSession()` inserts and `onMessage()` removes/resolves them.
	private eventHandlers = new Map<string, Set<EventHandler>>()
	private sessions = new Map<string, CDPSession>()
	/** Maps sessionId -> targetId (1:1 mapping) */
	private sessionToTarget = new Map<string, string>()
	private sessionDispatchWaiters = new Set<SessionDispatchWaiter>()
	public readonly id: string | null = null // root
	private transportCloseHandlers = new Set<(why: string) => void>()
	private _isClosed = false
	private _closeReason: string | null = null
	private _closePromise: Promise<void> | null = null

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

	private emitTransportClosed(why: string) {
		for (const h of this.transportCloseHandlers) {
			try {
				h(why)
			} catch {}
		}
	}

	private handleTransportClosed(why: string): void {
		if (this._closeReason) return
		this._closeReason = why
		this._isClosed = true
		this.resetAutoAttach()
		this.rejectAllInflight(why)
		this.emitTransportClosed(why)
		this.clearRetainedState()
	}

	private clearRetainedState(): void {
		this.eventHandlers.clear()
		this.sessions.clear()
		this.sessionToTarget.clear()
		this.sessionDispatchWaiters.clear()
		this.transportCloseHandlers.clear()
		this.transport.onmessage = undefined
		this.transport.onclose = undefined
		this.transport.onerror = undefined
	}

	private releaseTransportOwnership(): void {
		try {
			delete (this.transport as unknown as Record<symbol, unknown>)[
				TRANSPORT_OWNED
			]
		} catch {}
	}

	constructor(transport: CDPTransport) {
		super()
		const owned = (transport as unknown as Record<symbol, unknown>)[
			TRANSPORT_OWNED
		]
		if (owned) {
			throw new HandstageTransportAlreadyOwnedError("transport")
		}
		;(transport as unknown as Record<symbol, unknown>)[TRANSPORT_OWNED] = this
		this.transport = transport
		this.transport.onclose = (reason) => {
			const why = `transport-close reason=${String(reason || "")}`
			this.handleTransportClosed(why)
			this.releaseTransportOwnership()
		}

		this.transport.onerror = (err) => {
			const why = `transport-error ${err?.message ?? String(err)}`
			this.handleTransportClosed(why)
			this.releaseTransportOwnership()
		}
		this.transport.onmessage = (data) => this.onMessage(data)
	}

	static async connect(
		wsUrl: string,
		options?: { headers?: Record<string, string> },
	): Promise<CDPConnection> {
		// Include User-Agent header for server-side observability and version tracking
		// Merge user-provided headers, letting them override defaults
		const headers = {
			"User-Agent": `Handstage/${HANDSTAGE_VERSION}`,
			...options?.headers,
		}
		// @ts-expect-error: Modern runtimes like Bun support headers in native WebSocket
		const ws = new WebSocket(wsUrl, { headers })
		await new Promise<void>((resolve, reject) => {
			const onOpen = () => {
				ws.removeEventListener("error", onError)
				resolve()
			}
			const onError = () => {
				ws.removeEventListener("open", onOpen)
				try {
					ws.close()
				} catch {}
				reject(new Error("WebSocket error"))
			}
			ws.addEventListener("open", onOpen, { once: true })
			ws.addEventListener("error", onError, { once: true })
		})
		return new CDPConnection(createWebSocketTransport(ws))
	}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendRoot(method, undefined, ...params)
	}

	sendWithSignal<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendRoot(method, signal, ...params)
	}

	private sendRoot<M extends CDPCommand>(
		method: M,
		signal: AbortSignal | undefined,
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
		if (signal) {
			const onAbort = () => {
				const entry = this.inflight.get(id)
				if (!entry) return
				this.inflight.delete(id)
				entry.cleanup?.()
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
			}
		}
		// Prevent unhandledRejection if a session detaches before the caller awaits.
		void p.catch(() => {})
		try {
			this.transport.send(JSON.stringify(payload))
		} catch (error) {
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
		if (!set) return
		set.delete(handler)
		if (set.size === 0) this.eventHandlers.delete(event)
	}

	async close(): Promise<void> {
		if (this._closePromise) return this._closePromise

		this._closePromise = (async () => {
			this.handleTransportClosed("connection closed")
			try {
				await this.transport.close()
			} finally {
				this.clearRetainedState()
				this.releaseTransportOwnership()
			}
		})()

		return this._closePromise
	}

	private rejectAllInflight(why: string): void {
		for (const [id, entry] of this.inflight.entries()) {
			entry.cleanup?.()
			entry.reject(new CDPConnectionClosedError(why))
			this.inflight.delete(id)
		}
		for (const waiter of Array.from(this.sessionDispatchWaiters)) {
			waiter.reject(new CDPConnectionClosedError(why))
		}
	}

	getSession(sessionId: string): CDPSession | undefined {
		return this.sessions.get(sessionId)
	}

	waitForSessionDispatch<M extends CDPCommand>(
		sessionId: string,
		method: M,
		...params: CDPCommandParams<M>
	): Promise<void> {
		if (this._isClosed) {
			return Promise.reject(
				new CDPConnectionClosedError("connection is closed"),
			)
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: SessionDispatchWaiter = {
				sessionId,
				method,
				params: params[0],
				resolve: () => {
					this.sessionDispatchWaiters.delete(waiter)
					resolve()
				},
				reject: (error: Error) => {
					this.sessionDispatchWaiters.delete(waiter)
					reject(error)
				},
			}
			this.sessionDispatchWaiters.add(waiter)
		})
	}

	override async attachToTarget(targetId: string): Promise<CDPSession> {
		const { sessionId } = await this.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})
		if (this._isClosed) {
			throw new CDPConnectionClosedError("connection is closed")
		}

		let session = this.sessions.get(sessionId)
		if (!session) {
			session = new CDPSession(this, sessionId)
			this.sessions.set(sessionId, session)
		}
		this.sessionToTarget.set(sessionId, targetId)
		return session
	}

	override async getTargets(): Promise<Protocol.Target.TargetInfo[]> {
		const res = await this.send("Target.getTargets")
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

	private cleanupSession(sessionId: string, targetId?: string): void {
		for (const [id, entry] of this.inflight.entries()) {
			if (entry.sessionId !== sessionId) continue
			entry.reject(
				new PageNotFoundError(
					`target closed before CDP response (sessionId=${sessionId}, targetId=${targetId ?? "unknown"})`,
				),
			)
			entry.cleanup?.()
			this.inflight.delete(id)
		}
		for (const waiter of Array.from(this.sessionDispatchWaiters)) {
			if (waiter.sessionId !== sessionId) continue
			waiter.reject(
				new PageNotFoundError(
					`target closed before CDP send (sessionId=${sessionId}, targetId=${targetId ?? "unknown"})`,
				),
			)
		}
		this.sessions.delete(sessionId)
		this.sessionToTarget.delete(sessionId)
		for (const key of [...this.eventHandlers.keys()]) {
			if (key.startsWith(`${sessionId}:`)) this.eventHandlers.delete(key)
		}
	}

	private onMessage(json: string): void {
		const msg = JSON.parse(json) as RawMessage

		if ("id" in msg) {
			const rec = this.inflight.get(msg.id)
			if (!rec) return

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
		} else if (msg.method === "Target.targetDestroyed") {
			const { params } = msg
			for (const [sessionId, targetId] of [...this.sessionToTarget.entries()]) {
				if (targetId === params.targetId) {
					this.cleanupSession(sessionId, params.targetId)
				}
			}
		}

		const { method, params, sessionId } = msg

		const dispatch = () => {
			if (sessionId) {
				const session = this.sessions.get(sessionId)
				session?.dispatch(method, params)

				// Forward target lifecycle events to root listeners as well.
				// Some browsers emit these via a parent session rather than the root
				// connection; fan-out keeps target tracking consistent.
				if (method.startsWith("Target.")) {
					const handlers = this.eventHandlers.get(method)
					if (handlers) for (const h of handlers) invokeEventHandler(h, params)
				}
				return
			}

			const handlers = this.eventHandlers.get(method)
			if (handlers) for (const h of handlers) invokeEventHandler(h, params)
		}

		dispatch()
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
			...params,
		)
	}

	_sendViaSessionWithSignal<M extends CDPCommand>(
		sessionId: string,
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.sendViaSession(sessionId, method, signal, undefined, ...params)
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
		if (signal) {
			const onAbort = () => {
				const entry = this.inflight.get(id)
				if (!entry) return
				this.inflight.delete(id)
				entry.cleanup?.()
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
			}
		}
		// Prevent unhandledRejection if a session detaches before the caller awaits.
		void p.catch(() => {})
		try {
			this.transport.send(JSON.stringify(payload))
			dispatch?.resolve()
			for (const waiter of Array.from(this.sessionDispatchWaiters)) {
				if (waiter.sessionId !== sessionId) continue
				if (waiter.method !== method) continue
				if (!Object.is(waiter.params, requestParams)) continue
				waiter.resolve()
				break
			}
		} catch (error) {
			const sendError =
				error instanceof Error ? error : new Error(String(error))
			dispatch?.reject(sendError)
			const entry = this.inflight.get(id)
			this.inflight.delete(id)
			entry?.cleanup?.()
			entry?.reject(sendError)
			for (const waiter of [...this.sessionDispatchWaiters]) {
				if (waiter.sessionId !== sessionId) continue
				if (waiter.method !== method) continue
				if (!Object.is(waiter.params, requestParams)) continue
				waiter.reject(sendError)
				break
			}
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
		if (!set) return
		set.delete(handler)
		// Drop the bucket once empty so a long-lived connection doesn't
		// accumulate stale `${sessionId}:Event` keys after sessions detach.
		if (set.size === 0) this.eventHandlers.delete(key)
	}

	_dispatchToSession(
		sessionId: string,
		event: CDPEvent,
		params: CDPAnyEventParams,
	): void {
		const key = `${sessionId}:${event}`
		const handlers = this.eventHandlers.get(key)
		if (handlers) for (const h of handlers) invokeEventHandler(h, params)
	}
}

export class ExternalConnectionAdapter extends BaseCDPConnection {
	private transportCloseHandlers = new Set<(why: string) => void>()
	private sessions = new Map<string, CDPSessionLike>()
	private eventHandlers = new Map<string, Set<EventHandler>>()
	private rootEventHandlers = new Map<CDPEvent, EventHandler>()
	private sessionDispatchWaiters = new Set<SessionDispatchWaiter>()
	private sessionToTarget = new Map<string, string>()
	private closeReason: string | null = null
	private closePromise: Promise<void> | null = null
	private stateReleased = false
	private readonly previousOnClose: ExternalCDPSession["onclose"]
	private readonly adapterOnClose = (reason: string): void => {
		try {
			this.previousOnClose?.(reason)
		} finally {
			this.handleTransportClosed(`external-session-close reason=${reason}`)
			this.releaseRetainedState()
		}
	}

	constructor(private externalSession: ExternalCDPSession) {
		super()
		this.previousOnClose = externalSession.onclose
		const owned = (externalSession as unknown as Record<symbol, unknown>)[
			SESSION_OWNED
		]
		if (owned) {
			throw new HandstageTransportAlreadyOwnedError("session")
		}
		;(externalSession as unknown as Record<symbol, unknown>)[SESSION_OWNED] =
			this
		// Listen for flattened child session events if the external wrapper passes them
		this.on("Target.attachedToTarget", (params) => {
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
				this.cleanupChildSession(params.sessionId)
			}
		})
		this.on("Target.targetDestroyed", (params) => {
			if (!params?.targetId) return
			for (const [sessionId, targetId] of [...this.sessionToTarget.entries()]) {
				if (targetId === params.targetId) this.cleanupChildSession(sessionId)
			}
		})

		this.externalSession.onclose = this.adapterOnClose
	}

	private emitTransportClosed(why: string) {
		for (const h of this.transportCloseHandlers) {
			try {
				h(why)
			} catch {}
		}
	}

	private handleTransportClosed(why: string): void {
		if (this.closeReason) return
		this.closeReason = why
		this.resetAutoAttach()
		for (const waiter of Array.from(this.sessionDispatchWaiters)) {
			waiter.reject(new CDPConnectionClosedError(why))
		}
		this.sessionDispatchWaiters.clear()
		this.emitTransportClosed(why)
	}

	private cleanupChildSession(sessionId: string): void {
		this.sessions.delete(sessionId)
		this.sessionToTarget.delete(sessionId)
		for (const waiter of [...this.sessionDispatchWaiters]) {
			if (waiter.sessionId !== sessionId) continue
			waiter.reject(new PageNotFoundError(`sessionId=${sessionId}`))
		}
	}

	private releaseRetainedState(): void {
		if (this.stateReleased) return
		this.stateReleased = true
		for (const [event, handler] of this.rootEventHandlers.entries()) {
			this.externalSession.off(event, handler)
		}
		this.rootEventHandlers.clear()
		this.eventHandlers.clear()
		this.transportCloseHandlers.clear()
		this.sessions.clear()
		this.sessionToTarget.clear()

		if (this.externalSession.onclose === this.adapterOnClose) {
			this.externalSession.onclose = this.previousOnClose
		}
		try {
			delete (this.externalSession as unknown as Record<symbol, unknown>)[
				SESSION_OWNED
			]
		} catch {}
	}

	get id() {
		return this.externalSession.id
	}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		if (this.closeReason) {
			return Promise.reject(new CDPConnectionClosedError(this.closeReason))
		}
		return this.externalSession.send(method, ...params)
	}

	private ensureRootListener<E extends CDPEvent>(event: E) {
		if (!this.rootEventHandlers.has(event)) {
			const rootHandler = (params: CDPAnyEventParams) => {
				const rootHandlers = this.eventHandlers.get(event)
				if (rootHandlers) {
					for (const h of rootHandlers) invokeEventHandler(h, params)
				}
			}
			this.rootEventHandlers.set(event, rootHandler)
			this.externalSession.on(event, rootHandler)
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
		this.ensureRootListener(event)
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const set = this.eventHandlers.get(event)
		if (!set) return
		set.delete(handler)
		if (set.size === 0) {
			// Also detach the fan-out listener installed by `ensureRootListener`.
			this.eventHandlers.delete(event)
			const rootHandler = this.rootEventHandlers.get(event)
			if (rootHandler) {
				this.rootEventHandlers.delete(event)
				this.externalSession.off(event, rootHandler)
			}
		}
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.closePromise = (async () => {
			this.handleTransportClosed("connection closed")
			this.releaseRetainedState()
			await this.externalSession.close?.()
		})()
		return this.closePromise
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

	async waitForSessionDispatch<M extends CDPCommand>(
		sessionId: string,
		method: M,
		...params: CDPCommandParams<M>
	): Promise<void> {
		if (this.closeReason) {
			throw new CDPConnectionClosedError(this.closeReason)
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: SessionDispatchWaiter = {
				sessionId,
				method,
				params: params[0],
				resolve: () => {
					this.sessionDispatchWaiters.delete(waiter)
					resolve()
				},
				reject: (error: Error) => {
					this.sessionDispatchWaiters.delete(waiter)
					reject(error)
				},
			}
			this.sessionDispatchWaiters.add(waiter)
		})
	}

	override async attachToTarget(targetId: string): Promise<CDPSessionLike> {
		const { sessionId } = await this.send("Target.attachToTarget", {
			targetId,
			flatten: true,
		})
		if (this.closeReason) {
			throw new CDPConnectionClosedError(this.closeReason)
		}
		let session = this.sessions.get(sessionId)
		if (!session) {
			session = new ExternalSessionAdapter(this, sessionId)
			this.sessions.set(sessionId, session)
		}
		this.sessionToTarget.set(sessionId, targetId)
		return session
	}

	_notifySessionDispatch<M extends CDPCommand>(
		sessionId: string,
		method: M,
		...params: CDPCommandParams<M>
	): void {
		for (const waiter of [...this.sessionDispatchWaiters]) {
			if (waiter.sessionId !== sessionId) continue
			if (waiter.method !== method) continue
			if (!Object.is(waiter.params, params[0])) continue
			waiter.resolve()
			break
		}
	}
}

export class ExternalSessionAdapter implements CDPSessionLike {
	private static unsupportedChildSessionError(): Error {
		return new Error(
			"ExternalCDPSession does not support child target CDP sessions. Use connectTransport/connectWS for flattened session routing.",
		)
	}

	constructor(
		private adapter: ExternalConnectionAdapter,
		public readonly id: string,
	) {}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		this.adapter._notifySessionDispatch(this.id, method, ...params)
		return Promise.reject(ExternalSessionAdapter.unsupportedChildSessionError())
	}

	sendQueued<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>> {
		this.adapter._notifySessionDispatch(this.id, method, ...params)
		return {
			dispatched: Promise.resolve(),
			response: Promise.reject(
				ExternalSessionAdapter.unsupportedChildSessionError(),
			),
		}
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		void event
		void handler
		throw ExternalSessionAdapter.unsupportedChildSessionError()
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		void event
		void handler
		throw ExternalSessionAdapter.unsupportedChildSessionError()
	}

	async close(): Promise<void> {
		await this.adapter.send("Target.detachFromTarget", { sessionId: this.id })
	}
}

export class CDPSession implements CDPSessionLike {
	constructor(
		private readonly root: CDPConnection,
		public readonly id: string,
	) {}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.root._sendViaSession(this.id, method, ...params)
	}

	sendWithSignal<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.root._sendViaSessionWithSignal(
			this.id,
			method,
			signal,
			...params,
		)
	}

	sendQueued<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>> {
		return this.root._sendViaSessionQueued(this.id, method, ...params)
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		this.root._onSessionEvent(this.id, event, handler)
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		this.root._offSessionEvent(this.id, event, handler)
	}

	async close(): Promise<void> {
		await this.root.send("Target.detachFromTarget", {
			sessionId: this.id,
		})
	}

	dispatch(event: CDPEvent, params: CDPAnyEventParams): void {
		this.root._dispatchToSession(this.id, event, params)
	}
}
