import type { Protocol } from "devtools-protocol"
import WebSocket from "ws"
import { HANDSTAGES_VERSION } from "../../version"
import {
	CdpConnectionClosedError,
	PageNotFoundError,
} from "../types/public/sdkErrors"

/**
 * CDP transport & session multiplexer
 *
 * Owns the browser WebSocket and multiplexes flattened Target sessions.
 * Tracks inflight CDP calls, routes responses to the right session, and forwards events.
 *
 * This does not interpret Page/DOM/Runtime semantics — callers own that logic.
 */
export interface CDPSessionLike {
	send<R = unknown>(method: string, params?: object): Promise<R>
	on<P = unknown>(event: string, handler: (params: P) => void): void
	off<P = unknown>(event: string, handler: (params: P) => void): void
	close(): Promise<void>
	readonly id: string | null
}

export interface CDPTransport {
	send(message: string): void
	close(): void
	onmessage?: (message: string) => void
	onclose?: (reason: string) => void
	onerror?: (error: Error) => void
}

export interface ExternalCDPSession {
	send<R = unknown>(
		method: string,
		params?: object,
		sessionId?: string,
	): Promise<R>
	on<P = unknown>(
		event: string,
		handler: (params: P, sessionId?: string) => void,
	): void
	off<P = unknown>(
		event: string,
		handler: (params: P, sessionId?: string) => void,
	): void
	onclose?: (reason: string) => void
	close?(): Promise<void>
	readonly id: string | null
}

export interface CdpConnectionLike extends CDPSessionLike {
	getSession(sessionId: string): CDPSessionLike | undefined
	enableAutoAttach(): Promise<void>
	attachToTarget(targetId: string): Promise<CDPSessionLike>
	getTargets(): Promise<Protocol.Target.TargetInfo[]>
	onTransportClosed(handler: (why: string) => void): void
	offTransportClosed(handler: (why: string) => void): void
	waitForSessionDispatch(
		sessionId: string,
		method: string,
		match?: (params?: object) => boolean,
	): Promise<void>
}

type Inflight = {
	resolve: (value: unknown) => void
	reject: (e: Error) => void
	sessionId?: string | null
	method: string
	params?: object
	stack?: string
	ts: number
}

type EventHandler = (params: unknown) => void
type SessionDispatchWaiter = {
	sessionId: string
	method: string
	match?: (params?: object) => boolean
	resolve: () => void
	reject: (error: Error) => void
}

type RawMessage =
	| {
			id: number
			result?: unknown
			error?: { code: number; message: string; data?: unknown }
			sessionId?: string
	  }
	| { method: string; params?: unknown; sessionId?: string }

export abstract class BaseCdpConnection implements CdpConnectionLike {
	abstract send<R = unknown>(method: string, params?: object): Promise<R>
	abstract on<P = unknown>(event: string, handler: (params: P) => void): void
	abstract off<P = unknown>(event: string, handler: (params: P) => void): void
	abstract close(): Promise<void>
	abstract get id(): string | null
	abstract getSession(sessionId: string): CDPSessionLike | undefined
	abstract onTransportClosed(handler: (why: string) => void): void
	abstract offTransportClosed(handler: (why: string) => void): void
	abstract waitForSessionDispatch(
		sessionId: string,
		method: string,
		match?: (params?: object) => boolean,
	): Promise<void>

	// Memoize the in-flight enable so concurrent V3Contexts sharing the
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

	async attachToTarget(targetId: string): Promise<CDPSessionLike> {
		const { sessionId } = (await this.send<{ sessionId: string }>(
			"Target.attachToTarget",
			{ targetId, flatten: true },
		)) as { sessionId: string }

		let session = this.getSession(sessionId)
		if (!session) {
			session = this._createSession(sessionId)
			this._setSession(sessionId, session)
		}
		this._mapTarget(sessionId, targetId)
		return session
	}

	async getTargets(): Promise<Protocol.Target.TargetInfo[]> {
		const res = await this.send<{
			targetInfos: Protocol.Target.TargetInfo[]
		}>("Target.getTargets")
		return res.targetInfos
	}

	protected abstract _createSession(sessionId: string): CDPSessionLike
	protected abstract _setSession(
		sessionId: string,
		session: CDPSessionLike,
	): void
	protected abstract _mapTarget(sessionId: string, targetId: string): void
}

export class CdpConnection extends BaseCdpConnection {
	private transport: CDPTransport
	private nextId = 1
	private inflight = new Map<number, Inflight>() // Outstanding request records; `_sendViaSession()` inserts and `onMessage()` removes/resolves them.
	private eventHandlers = new Map<string, Set<EventHandler>>()
	private sessions = new Map<string, CdpSession>()
	/** Maps sessionId -> targetId (1:1 mapping) */
	private sessionToTarget = new Map<string, string>()
	private sessionDispatchWaiters = new Set<SessionDispatchWaiter>()
	public readonly id: string | null = null // root
	private transportCloseHandlers = new Set<(why: string) => void>()

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
		this.transport = transport
		this.transport.onclose = (reason) => {
			const why = `transport-close reason=${String(reason || "")}`
			this.rejectAllInflight(why)
			this.emitTransportClosed(why)
		}

		this.transport.onerror = (err) => {
			const why = `transport-error ${err?.message ?? String(err)}`
			this.rejectAllInflight(why)
			this.emitTransportClosed(why)
		}
		this.transport.onmessage = (data) => this.onMessage(data)
	}

	static async connect(
		wsUrl: string,
		options?: { headers?: Record<string, string> },
	): Promise<CdpConnection> {
		// Include User-Agent header for server-side observability and version tracking
		// Merge user-provided headers, letting them override defaults
		const headers = {
			"User-Agent": `Handstages/${HANDSTAGES_VERSION}`,
			...options?.headers,
		}
		const ws = new WebSocket(wsUrl, { headers })
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve())
			ws.once("error", (e) => reject(e))
		})
		const transport: CDPTransport = {
			send: (message) => ws.send(message),
			close: () => ws.close(),
		}
		ws.on("message", (data) => {
			if (transport.onmessage) transport.onmessage(data.toString())
		})
		ws.on("close", (code, reason) => {
			if (transport.onclose) transport.onclose(`code=${code} reason=${reason}`)
		})
		ws.on("error", (error) => {
			if (transport.onerror) transport.onerror(error)
		})
		return new CdpConnection(transport)
	}

	async send<R = unknown>(method: string, params?: object): Promise<R> {
		const id = this.nextId++
		const payload = { id, method, params }
		const stack = new Error().stack?.split("\n").slice(1, 4).join("\n")
		const p = new Promise<R>((resolve, reject) => {
			this.inflight.set(id, {
				resolve: (v: unknown) => resolve(v as R),
				reject,
				sessionId: null,
				method,
				params,
				stack,
				ts: Date.now(),
			})
		})
		// Prevent unhandledRejection if a session detaches before the caller awaits.
		void p.catch(() => {})
		this.transport.send(JSON.stringify(payload))
		return p
	}

	on<P = unknown>(event: string, handler: (params: P) => void): void {
		const set = this.eventHandlers.get(event) ?? new Set<EventHandler>()
		set.add(handler as EventHandler)
		this.eventHandlers.set(event, set)
	}

	off<P = unknown>(event: string, handler: (params: P) => void): void {
		const set = this.eventHandlers.get(event)
		if (set) set.delete(handler as EventHandler)
	}

	async close(): Promise<void> {
		this.transport.close()
	}

	private rejectAllInflight(why: string): void {
		for (const [id, entry] of this.inflight.entries()) {
			entry.reject(new CdpConnectionClosedError(why))
			this.inflight.delete(id)
		}
		for (const waiter of Array.from(this.sessionDispatchWaiters)) {
			waiter.reject(new CdpConnectionClosedError(why))
		}
	}

	getSession(sessionId: string): CdpSession | undefined {
		return this.sessions.get(sessionId)
	}

	waitForSessionDispatch(
		sessionId: string,
		method: string,
		match?: (params?: object) => boolean,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const waiter: SessionDispatchWaiter = {
				sessionId,
				method,
				match,
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

	async attachToTarget(targetId: string): Promise<CdpSession> {
		const { sessionId } = (await this.send<{ sessionId: string }>(
			"Target.attachToTarget",
			{ targetId, flatten: true },
		)) as { sessionId: string }

		let session = this.sessions.get(sessionId)
		if (!session) {
			session = new CdpSession(this, sessionId)
			this.sessions.set(sessionId, session)
		}
		this.sessionToTarget.set(sessionId, targetId)
		return session
	}

	async getTargets(): Promise<Protocol.Target.TargetInfo[]> {
		const res = await this.send<{
			targetInfos: Protocol.Target.TargetInfo[]
		}>("Target.getTargets")
		return res.targetInfos
	}

	protected _createSession(sessionId: string): CDPSessionLike {
		return new CdpSession(this, sessionId)
	}

	protected _setSession(sessionId: string, session: CDPSessionLike): void {
		this.sessions.set(sessionId, session as CdpSession)
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

			if ("error" in msg && msg.error) {
				rec.reject(new Error(`${msg.error.code} ${msg.error.message}`))
			} else {
				rec.resolve((msg as { result?: unknown }).result)
			}
			return
		}

		if ("method" in msg) {
			if (msg.method === "Target.attachedToTarget") {
				const p = (msg as { params: Protocol.Target.AttachedToTargetEvent })
					.params
				if (!this.sessions.has(p.sessionId)) {
					this.sessions.set(p.sessionId, new CdpSession(this, p.sessionId))
				}
				this.sessionToTarget.set(p.sessionId, p.targetInfo.targetId)
			} else if (msg.method === "Target.detachedFromTarget") {
				const p = (msg as { params: Protocol.Target.DetachedFromTargetEvent })
					.params
				for (const [id, entry] of this.inflight.entries()) {
					if (entry.sessionId === p.sessionId) {
						entry.reject(
							new PageNotFoundError(
								`target closed before CDP response (sessionId=${p.sessionId}, targetId=${p.targetId})`,
							),
						)
						this.inflight.delete(id)
					}
				}
				for (const waiter of Array.from(this.sessionDispatchWaiters)) {
					if (waiter.sessionId === p.sessionId) {
						waiter.reject(
							new PageNotFoundError(
								`target closed before CDP send (sessionId=${p.sessionId}, targetId=${p.targetId})`,
							),
						)
					}
				}
				this.sessions.delete(p.sessionId)
				this.sessionToTarget.delete(p.sessionId)
			} else if (msg.method === "Target.targetDestroyed") {
				const p = (msg as { params: { targetId: string } }).params
				// Remove any session mapping for this target
				for (const [sessionId, targetId] of this.sessionToTarget.entries()) {
					if (targetId === p.targetId) {
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
						if (handlers) for (const h of handlers) h(params)
					}
					return
				}

				const handlers = this.eventHandlers.get(method)
				if (handlers) for (const h of handlers) h(params)
			}

			dispatch()
		}
	}

	_sendViaSession<R = unknown>(
		sessionId: string,
		method: string,
		params?: object,
	): Promise<R> {
		const id = this.nextId++
		const payload = { id, method, params, sessionId }
		const stack = new Error().stack?.split("\n").slice(1, 4).join("\n")
		const p = new Promise<R>((resolve, reject) => {
			this.inflight.set(id, {
				resolve: (v: unknown) => resolve(v as R),
				reject,
				sessionId,
				method,
				params,
				stack,
				ts: Date.now(),
			})
		})
		// Prevent unhandledRejection if a session detaches before the caller awaits.
		void p.catch(() => {})
		for (const waiter of Array.from(this.sessionDispatchWaiters)) {
			if (waiter.sessionId !== sessionId) continue
			if (waiter.method !== method) continue
			if (waiter.match && !waiter.match(params)) continue
			waiter.resolve()
			break
		}
		this.transport.send(JSON.stringify(payload))
		return p
	}

	_onSessionEvent(
		sessionId: string,
		event: string,
		handler: EventHandler,
	): void {
		const key = `${sessionId}:${event}`
		const set = this.eventHandlers.get(key) ?? new Set<EventHandler>()
		set.add(handler)
		this.eventHandlers.set(key, set)
	}

	_offSessionEvent(
		sessionId: string,
		event: string,
		handler: EventHandler,
	): void {
		const key = `${sessionId}:${event}`
		const set = this.eventHandlers.get(key)
		if (!set) return
		set.delete(handler)
		// Drop the bucket once empty so a long-lived connection doesn't
		// accumulate stale `${sessionId}:Event` keys after sessions detach.
		if (set.size === 0) this.eventHandlers.delete(key)
	}

	_dispatchToSession(sessionId: string, event: string, params: unknown): void {
		const key = `${sessionId}:${event}`
		const handlers = this.eventHandlers.get(key)
		if (handlers) for (const h of handlers) h(params)
	}
}

export class ExternalConnectionAdapter extends BaseCdpConnection {
	private transportCloseHandlers = new Set<(why: string) => void>()
	private sessions = new Map<string, ExternalSessionAdapter>()
	private eventHandlers = new Map<string, Set<(params: unknown) => void>>()
	private rootEventHandlers = new Map<
		string,
		(params: unknown, sessionId?: string) => void
	>()
	private sessionDispatchWaiters = new Set<SessionDispatchWaiter>()
	private sessionToTarget = new Map<string, string>()

	constructor(private externalSession: ExternalCDPSession) {
		super()
		// Listen for flattened child session events if the external wrapper passes them
		this.on<{ sessionId: string; targetInfo: any }>(
			"Target.attachedToTarget",
			(params) => {
				if (params?.sessionId && !this.sessions.has(params.sessionId)) {
					this.sessions.set(
						params.sessionId,
						new ExternalSessionAdapter(this, params.sessionId),
					)
				}
			},
		)
		this.on<{ sessionId: string; targetId: string }>(
			"Target.detachedFromTarget",
			(params) => {
				if (params?.sessionId) {
					this.sessions.delete(params.sessionId)
				}
			},
		)

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

	async send<R = unknown>(method: string, params?: object): Promise<R> {
		return this.externalSession.send<R>(method, params)
	}

	private ensureRootListener(event: string) {
		if (!this.rootEventHandlers.has(event)) {
			const rootHandler = (params: unknown, targetSessionId?: string) => {
				if (targetSessionId) {
					const childKey = `${targetSessionId}:${event}`
					const childHandlers = this.eventHandlers.get(childKey)
					if (childHandlers) {
						for (const h of childHandlers) h(params)
					}

					// Forward target lifecycle events to root listeners as well.
					if (event.startsWith("Target.")) {
						const rootHandlers = this.eventHandlers.get(event)
						if (rootHandlers) for (const h of rootHandlers) h(params)
					}
				} else {
					const rootHandlers = this.eventHandlers.get(event)
					if (rootHandlers) for (const h of rootHandlers) h(params)
				}
			}
			this.rootEventHandlers.set(event, rootHandler)
			this.externalSession.on(event, rootHandler)
		}
	}

	on<P = unknown>(event: string, handler: (params: P) => void): void {
		let set = this.eventHandlers.get(event)
		if (!set) {
			set = new Set()
			this.eventHandlers.set(event, set)
		}
		set.add(handler)
		this.ensureRootListener(event)
	}

	off<P = unknown>(event: string, handler: (params: P) => void): void {
		const set = this.eventHandlers.get(event)
		if (set) {
			set.delete(handler as (params: unknown) => void)
		}
	}

	async close(): Promise<void> {
		for (const waiter of Array.from(this.sessionDispatchWaiters)) {
			waiter.reject(new CdpConnectionClosedError("connection closed"))
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
		this.sessions.set(sessionId, session as ExternalSessionAdapter)
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

	async waitForSessionDispatch(
		sessionId: string,
		method: string,
		match?: (params?: object) => boolean,
	): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const waiter: SessionDispatchWaiter = {
				sessionId,
				method,
				match,
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

	async sendToSession<R = unknown>(
		sessionId: string,
		method: string,
		params?: object,
	): Promise<R> {
		const p = this.externalSession.send<R>(method, params, sessionId)

		for (const waiter of Array.from(this.sessionDispatchWaiters)) {
			if (waiter.sessionId !== sessionId) continue
			if (waiter.method !== method) continue
			if (waiter.match && !waiter.match(params)) continue
			waiter.resolve()
			break
		}

		return p
	}

	onSessionEvent(
		sessionId: string,
		event: string,
		handler: (params: unknown) => void,
	) {
		const key = `${sessionId}:${event}`
		let set = this.eventHandlers.get(key)
		if (!set) {
			set = new Set()
			this.eventHandlers.set(key, set)
		}
		set.add(handler)
		this.ensureRootListener(event)
	}

	offSessionEvent(
		sessionId: string,
		event: string,
		handler: (params: unknown) => void,
	) {
		const key = `${sessionId}:${event}`
		const set = this.eventHandlers.get(key)
		if (set) {
			set.delete(handler)
		}
	}
}

export class ExternalSessionAdapter implements CDPSessionLike {
	constructor(
		private adapter: ExternalConnectionAdapter,
		public readonly id: string,
	) {}

	send<R = unknown>(method: string, params?: object): Promise<R> {
		return this.adapter.sendToSession(this.id, method, params)
	}

	on<P = unknown>(event: string, handler: (params: P) => void): void {
		this.adapter.onSessionEvent(this.id, event, handler)
	}

	off<P = unknown>(event: string, handler: (params: P) => void): void {
		this.adapter.offSessionEvent(this.id, event, handler)
	}

	async close(): Promise<void> {
		await this.adapter.send("Target.detachFromTarget", { sessionId: this.id })
	}
}

export class CdpSession implements CDPSessionLike {
	constructor(
		private readonly root: CdpConnection,
		public readonly id: string,
	) {}

	send<R = unknown>(method: string, params?: object): Promise<R> {
		return this.root._sendViaSession<R>(this.id, method, params)
	}

	on<P = unknown>(event: string, handler: (params: P) => void): void {
		this.root._onSessionEvent(this.id, event, handler as EventHandler)
	}

	off<P = unknown>(event: string, handler: (params: P) => void): void {
		this.root._offSessionEvent(this.id, event, handler as EventHandler)
	}

	async close(): Promise<void> {
		await this.root.send<void>("Target.detachFromTarget", {
			sessionId: this.id,
		})
	}

	dispatch(event: string, params: unknown): void {
		this.root._dispatchToSession(this.id, event, params)
	}
}
