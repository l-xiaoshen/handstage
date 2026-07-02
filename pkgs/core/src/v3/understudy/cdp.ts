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

type Inflight = {
	resolve: (value: CDPAnyCommandResult) => void
	reject: (e: Error) => void
	sessionId?: string | null
	method: string
	params?: CDPAnyCommandParams
	stack?: string
	ts: number
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

	public onTransportClosed(handler: (why: string) => void): void {
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
			this._isClosed = true
			const why = `transport-close reason=${String(reason || "")}`
			this.rejectAllInflight(why)
			this.emitTransportClosed(why)
		}

		this.transport.onerror = (err) => {
			this._isClosed = true
			const why = `transport-error ${err?.message ?? String(err)}`
			this.rejectAllInflight(why)
			this.emitTransportClosed(why)
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
			// Remove BOTH handshake listeners once either fires so the losing
			// `{ once: true }` listener doesn't linger on the socket forever.
			const cleanup = () => {
				ws.removeEventListener("open", onOpen)
				ws.removeEventListener("error", onErr)
			}
			const onOpen = () => {
				cleanup()
				resolve()
			}
			const onErr = () => {
				cleanup()
				reject(new Error("WebSocket error"))
			}
			ws.addEventListener("open", onOpen)
			ws.addEventListener("error", onErr)
		})
		const onMessage = (event: MessageEvent) => {
			if (transport.onmessage) transport.onmessage(event.data.toString())
		}
		const onClose = (event: CloseEvent) => {
			if (transport.onclose)
				transport.onclose(`code=${event.code} reason=${event.reason}`)
		}
		const onError = () => {
			if (transport.onerror) transport.onerror(new Error("WebSocket error"))
		}
		const transport: CDPTransport = {
			send: (message) => ws.send(message),
			close: () => {
				ws.removeEventListener("message", onMessage)
				ws.removeEventListener("close", onClose)
				ws.removeEventListener("error", onError)
				ws.close()
			},
		}
		ws.addEventListener("message", onMessage)
		ws.addEventListener("close", onClose)
		ws.addEventListener("error", onError)
		return new CDPConnection(transport)
	}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		if (this._isClosed) {
			return Promise.reject(
				new CDPConnectionClosedError(
					`Cannot send ${method}: connection is closed`,
				),
			)
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
		// Prevent unhandledRejection if a session detaches before the caller awaits.
		void p.catch(() => {})
		this.transport.send(JSON.stringify(payload))
		return p
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const set = this.eventHandlers.get(event) ?? new Set<EventHandler>()
		set.add(handler)
		this.eventHandlers.set(event, set)
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const set = this.eventHandlers.get(event)
		if (set) set.delete(handler)
	}

	async close(): Promise<void> {
		this._isClosed = true
		try {
			await this.transport.close()
		} finally {
			// Settle awaiters and drop references here rather than relying on
			// `transport.onclose` — the local Chrome pipe suppresses it on a
			// graceful close, which would otherwise leave `send()` promises
			// pending forever and retain the maps. Idempotent: a later racing
			// `onclose` re-runs this on empty maps.
			this.rejectAllInflight("connection closed")
			this.eventHandlers.clear()
			this.sessions.clear()
			this.sessionToTarget.clear()
			this.sessionDispatchWaiters.clear()
			this.transportCloseHandlers.clear()

			// Release ownership so a future caller could re-wrap a fresh
			// transport with the same identity (rare; mainly relevant in
			// long-running tests that reuse fake transports).
			try {
				delete (this.transport as unknown as Record<symbol, unknown>)[
					TRANSPORT_OWNED
				]
			} catch {}
		}
	}

	private rejectAllInflight(why: string): void {
		for (const [id, entry] of this.inflight.entries()) {
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

	private onMessage(json: string): void {
		const msg = JSON.parse(json) as RawMessage

		if ("id" in msg) {
			const rec = this.inflight.get(msg.id)
			if (!rec) return

			this.inflight.delete(msg.id)

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
			for (const [id, entry] of this.inflight.entries()) {
				if (entry.sessionId === params.sessionId) {
					entry.reject(
						new PageNotFoundError(
							`target closed before CDP response (sessionId=${params.sessionId}, targetId=${params.targetId})`,
						),
					)
					this.inflight.delete(id)
				}
			}
			for (const waiter of Array.from(this.sessionDispatchWaiters)) {
				if (waiter.sessionId === params.sessionId) {
					waiter.reject(
						new PageNotFoundError(
							`target closed before CDP send (sessionId=${params.sessionId}, targetId=${params.targetId})`,
						),
					)
				}
			}
			this.sessions.delete(params.sessionId)
			this.sessionToTarget.delete(params.sessionId)

			// Backstop against a missed `.off()`: drop session-scoped handler
			// buckets (`${sessionId}:Event`). Root keys are plain event names, so
			// they're unaffected.
			const sessionKeyPrefix = `${params.sessionId}:`
			for (const key of Array.from(this.eventHandlers.keys())) {
				if (key.startsWith(sessionKeyPrefix)) this.eventHandlers.delete(key)
			}
		} else if (msg.method === "Target.targetDestroyed") {
			const { params } = msg
			// Remove any session mapping for this target
			for (const [sessionId, targetId] of this.sessionToTarget.entries()) {
				if (targetId === params.targetId) {
					this.sessionToTarget.delete(sessionId)
					break
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
		if (this._isClosed) {
			return Promise.reject(
				new CDPConnectionClosedError(
					`Cannot send ${method}: connection is closed`,
				),
			)
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
		// Prevent unhandledRejection if a session detaches before the caller awaits.
		void p.catch(() => {})
		for (const waiter of Array.from(this.sessionDispatchWaiters)) {
			if (waiter.sessionId !== sessionId) continue
			if (waiter.method !== method) continue
			if (!Object.is(waiter.params, requestParams)) continue
			waiter.resolve()
			break
		}
		this.transport.send(JSON.stringify(payload))
		return p
	}

	_onSessionEvent<E extends CDPEvent>(
		sessionId: string,
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
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

	constructor(private externalSession: ExternalCDPSession) {
		super()
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
		})
		this.on("Target.detachedFromTarget", (params) => {
			if (params?.sessionId) {
				this.sessions.delete(params.sessionId)
			}
		})

		this.externalSession.onclose = (reason: string) => {
			this.emitTransportClosed(`external-session-close reason=${reason}`)
		}
	}

	private emitTransportClosed(why: string) {
		for (const h of this.transportCloseHandlers) {
			try {
				h(why)
			} catch {}
		}
	}

	get id() {
		return this.externalSession.id
	}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
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
		if (set) {
			set.delete(handler)
		}
	}

	async close(): Promise<void> {
		for (const waiter of Array.from(this.sessionDispatchWaiters)) {
			waiter.reject(new CDPConnectionClosedError("connection closed"))
		}
		this.sessionDispatchWaiters.clear()

		for (const [event, handler] of this.rootEventHandlers.entries()) {
			this.externalSession.off(event, handler)
		}
		this.rootEventHandlers.clear()
		this.eventHandlers.clear()

		this.transportCloseHandlers.clear()
		this.sessions.clear()

		if (this.externalSession.onclose) {
			this.externalSession.onclose = undefined
		}

		try {
			delete (this.externalSession as unknown as Record<symbol, unknown>)[
				SESSION_OWNED
			]
		} catch {}

		// If external session has a close method, invoke it, otherwise no-op.
		if (typeof this.externalSession.close === "function") {
			await this.externalSession.close()
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

	onTransportClosed(handler: (why: string) => void): void {
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
		void method
		void params
		return Promise.reject(ExternalSessionAdapter.unsupportedChildSessionError())
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
