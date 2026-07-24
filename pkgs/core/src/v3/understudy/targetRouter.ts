import type { Protocol } from "devtools-protocol"
import { defaultLogger, type LogSink } from "../logger"
import { LogLevel } from "../types/public/logs"
import { raceAgainstSignal } from "./abortUtils"
import {
	type CDPConnectionLike,
	queueCDPCommand,
	sendCDPWithSignal,
} from "./cdp"
import { errorMessage } from "./protocolError"

type SessionId = string
type TargetId = string
type RouteToken = {
	targetId: TargetId
	candidate?: TargetRouterDelegate
}

export interface TargetRouterDelegate {
	canClaimTarget(info: Protocol.Target.TargetInfo): Promise<boolean> | boolean
	onRouterAttachedToTarget(
		info: Protocol.Target.TargetInfo,
		sessionId: SessionId,
	): Promise<void> | void
	onRouterDetachedFromTarget(
		sessionId: SessionId,
		targetId: TargetId | null,
	): void
	onRouterTargetDestroyed(targetId: TargetId): void
}

/**
 * Connection-level Target domain coordinator.
 *
 * CDP auto-attach is browser-wide for a websocket.  If each Context installs
 * its own Target listeners and independently filters by browserContextId, a
 * foreign target can remain paused by `waitForDebuggerOnStart` when the context
 * that saw it decides it is out-of-scope.  TargetRouter makes ownership a
 * single connection-level decision: exactly one registered context receives a
 * target, and every unclaimed session is immediately resumed and detached.
 *
 * One router per CDP connection — when multiple Handstage instances share a
 * connection they all register against the same router.  Router-level debug
 * lines are broadcast to every registered delegate's logger so each Handstage sees
 * the events that affected it; if no loggers are registered (router-only
 * lifecycle window) a console fallback is used.
 */
export class TargetRouter {
	private delegates: TargetRouterDelegate[] = []
	private loggers = new Map<TargetRouterDelegate, LogSink>()
	private sessionOwners = new Map<SessionId, TargetRouterDelegate>()
	private sessionTargets = new Map<SessionId, TargetId>()
	private routeTokens = new Map<SessionId, RouteToken>()
	private started = false
	private closed = false
	private startPromise: Promise<void> | null = null
	private startController: AbortController | null = null
	private readonly startWaiters = new Set<object>()
	private listeningAttached = false
	private listeningDetached = false
	private listeningDestroyed = false

	private constructor(private readonly conn: CDPConnectionLike) {
		this.conn.onTransportClosed(this.onConnectionClosed)
	}

	public static forConnection(conn: CDPConnectionLike): TargetRouter {
		let router = routers.get(conn)
		if (!router) {
			router = new TargetRouter(conn)
			routers.set(conn, router)
		}
		return router
	}

	public async register(
		delegate: TargetRouterDelegate,
		logger?: LogSink,
		signal?: AbortSignal,
	): Promise<() => void> {
		if (this.closed) {
			throw new Error("Cannot register a context on a closed TargetRouter")
		}
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("TargetRouter registration aborted")
		}
		if (!this.delegates.includes(delegate)) {
			this.delegates.push(delegate)
		}
		if (logger) {
			this.loggers.set(delegate, logger)
		}
		const onAbort = () => this.unregister(delegate)
		signal?.addEventListener("abort", onAbort, { once: true })
		try {
			await this.start(signal)
			if (signal?.aborted) {
				throw signal.reason instanceof Error
					? signal.reason
					: new Error("TargetRouter registration aborted")
			}
		} catch (err) {
			// The caller never receives the unsubscribe function on failure.
			signal?.removeEventListener("abort", onAbort)
			this.unregister(delegate)
			throw err
		}
		let registered = true
		return () => {
			if (!registered) {
				return
			}
			registered = false
			signal?.removeEventListener("abort", onAbort)
			this.unregister(delegate)
		}
	}

	public unregister(delegate: TargetRouterDelegate): void {
		this.delegates = this.delegates.filter((d) => d !== delegate)
		this.loggers.delete(delegate)
		for (const [sessionId, owner] of [...this.sessionOwners.entries()]) {
			if (owner === delegate) {
				this.routeTokens.delete(sessionId)
				this.sessionOwners.delete(sessionId)
				this.sessionTargets.delete(sessionId)
				void this.resumeAndDetach(sessionId)
			}
		}
		for (const [sessionId, token] of [...this.routeTokens.entries()]) {
			if (token.candidate !== delegate) {
				continue
			}
			this.invalidateRoute(sessionId, token)
			void this.resumeAndDetach(sessionId)
		}

		// Keep the root Target listeners installed even with zero delegates.
		// Auto-attach is browser-wide and remains enabled on the connection; a
		// future target must still be resumed/detached rather than left paused.
	}

	/** Fan a router-level debug line out to every registered delegate's logger. */
	private log(line: {
		category: string
		message: string
		level: LogLevel
		attributes?: Record<string, unknown>
	}): void {
		if (this.loggers.size === 0) {
			try {
				defaultLogger()(line)
			} catch {}
			return
		}
		for (const sink of this.loggers.values()) {
			try {
				sink(line)
			} catch {}
		}
	}

	private async start(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("TargetRouter startup aborted")
		}
		if (this.started) {
			return
		}
		let operation = this.startPromise
		let controller = this.startController
		if (!operation || !controller) {
			controller = new AbortController()
			operation = (async () => {
				try {
					if (!this.listeningAttached) {
						this.conn.on("Target.attachedToTarget", this.onAttachedToTarget)
						this.listeningAttached = true
					}
					if (!this.listeningDetached) {
						this.conn.on("Target.detachedFromTarget", this.onDetachedFromTarget)
						this.listeningDetached = true
					}
					if (!this.listeningDestroyed) {
						this.conn.on("Target.targetDestroyed", this.onTargetDestroyed)
						this.listeningDestroyed = true
					}
					await this.conn.enableAutoAttach(controller.signal)
					if (this.closed) {
						throw new Error("TargetRouter closed during startup")
					}
					this.started = true
				} catch (err) {
					// Keep any installed attach listener as a fail-safe. If auto-attach was
					// only partially enabled, unclaimed targets must still be resumed.
					this.started = false
					throw err
				}
			})()
			this.startPromise = operation
			this.startController = controller
		}
		const activeOperation = operation
		const activeController = controller
		void activeOperation.then(
			() => this.finishStart(activeOperation),
			() => this.finishStart(activeOperation),
		)

		const waiter = {}
		this.startWaiters.add(waiter)
		try {
			await this.waitForStart(activeOperation, signal)
		} finally {
			this.startWaiters.delete(waiter)
			if (
				this.startPromise === activeOperation &&
				!this.started &&
				this.startWaiters.size === 0 &&
				!activeController.signal.aborted
			) {
				this.startPromise = null
				this.startController = null
				activeController.abort(
					new Error("TargetRouter startup has no active callers"),
				)
			}
		}
	}

	private finishStart(operation: Promise<void>): void {
		if (this.startPromise !== operation) {
			return
		}
		this.startPromise = null
		this.startController = null
	}

	private waitForStart(
		operation: Promise<void>,
		signal?: AbortSignal,
	): Promise<void> {
		if (!signal) {
			return operation
		}
		return raceAgainstSignal(operation, signal, "TargetRouter startup aborted")
	}

	private stop(): void {
		if (this.listeningAttached) {
			this.listeningAttached = false
			try {
				this.conn.off("Target.attachedToTarget", this.onAttachedToTarget)
			} catch {}
		}
		if (this.listeningDetached) {
			this.listeningDetached = false
			try {
				this.conn.off("Target.detachedFromTarget", this.onDetachedFromTarget)
			} catch {}
		}
		if (this.listeningDestroyed) {
			this.listeningDestroyed = false
			try {
				this.conn.off("Target.targetDestroyed", this.onTargetDestroyed)
			} catch {}
		}
		this.routeTokens.clear()
		this.sessionOwners.clear()
		this.sessionTargets.clear()
		this.started = false
	}

	private onConnectionClosed = (): void => {
		if (this.closed) {
			return
		}
		this.closed = true
		if (this.startController && !this.startController.signal.aborted) {
			this.startController.abort(
				new Error("TargetRouter connection closed during startup"),
			)
		}
		this.stop()
		this.delegates = []
		this.loggers.clear()
		this.conn.offTransportClosed(this.onConnectionClosed)
	}

	private onAttachedToTarget = (
		evt: Protocol.Target.AttachedToTargetEvent,
	): void => {
		if (this.closed) {
			void this.resumeAndDetach(evt.sessionId)
			return
		}
		const token: RouteToken = { targetId: evt.targetInfo.targetId }
		this.routeTokens.set(evt.sessionId, token)
		void this.routeAttached(evt, token).catch((err) => {
			const shouldRelinquish = this.invalidateRoute(evt.sessionId, token)
			this.log({
				category: "target-router",
				message: "Target attach routing failed",
				level: LogLevel.Debug,
				attributes: {
					targetId: evt?.targetInfo?.targetId,
					sessionId: evt?.sessionId,
					error: errorMessage(err),
				},
			})
			if (shouldRelinquish) {
				void this.resumeAndDetach(evt.sessionId)
			}
		})
	}

	private async routeAttached(
		evt: Protocol.Target.AttachedToTargetEvent,
		token: RouteToken,
	): Promise<void> {
		if (!this.isRouteCurrent(evt.sessionId, token)) {
			return
		}

		const owner = await this.findOwner(evt.targetInfo, evt.sessionId, token)
		if (!this.isRouteCurrent(evt.sessionId, token)) {
			return
		}
		if (!owner) {
			this.invalidateRoute(evt.sessionId, token)
			await this.resumeAndDetach(evt.sessionId)
			return
		}
		if (this.closed || !this.delegates.includes(owner)) {
			this.invalidateRoute(evt.sessionId, token)
			await this.resumeAndDetach(evt.sessionId)
			return
		}

		this.sessionOwners.set(evt.sessionId, owner)
		this.sessionTargets.set(evt.sessionId, evt.targetInfo.targetId)
		await owner.onRouterAttachedToTarget(evt.targetInfo, evt.sessionId)
	}

	private isRouteCurrent(sessionId: SessionId, token: RouteToken): boolean {
		return !this.closed && this.routeTokens.get(sessionId) === token
	}

	private invalidateRoute(sessionId: SessionId, token: RouteToken): boolean {
		if (this.routeTokens.get(sessionId) !== token) {
			return false
		}
		this.routeTokens.delete(sessionId)
		this.sessionOwners.delete(sessionId)
		this.sessionTargets.delete(sessionId)
		return true
	}

	private onDetachedFromTarget = (
		evt: Protocol.Target.DetachedFromTargetEvent,
	): void => {
		this.routeTokens.delete(evt.sessionId)
		const owner = this.sessionOwners.get(evt.sessionId)
		const targetId =
			evt.targetId ?? this.sessionTargets.get(evt.sessionId) ?? null
		this.sessionOwners.delete(evt.sessionId)
		this.sessionTargets.delete(evt.sessionId)
		if (owner) {
			owner.onRouterDetachedFromTarget(evt.sessionId, targetId)
			return
		}

		for (const delegate of this.delegates) {
			delegate.onRouterDetachedFromTarget(evt.sessionId, targetId)
		}
	}

	private onTargetDestroyed = (
		evt: Protocol.Target.TargetDestroyedEvent,
	): void => {
		for (const [sessionId, token] of [...this.routeTokens.entries()]) {
			if (token.targetId === evt.targetId) {
				this.routeTokens.delete(sessionId)
			}
		}
		for (const [sessionId, targetId] of [...this.sessionTargets.entries()]) {
			if (targetId !== evt.targetId) {
				continue
			}
			const owner = this.sessionOwners.get(sessionId)
			this.sessionTargets.delete(sessionId)
			this.sessionOwners.delete(sessionId)
			owner?.onRouterDetachedFromTarget(sessionId, evt.targetId)
		}
		for (const delegate of this.delegates) {
			delegate.onRouterTargetDestroyed(evt.targetId)
		}
	}

	private async findOwner(
		info: Protocol.Target.TargetInfo,
		sessionId: SessionId,
		token: RouteToken,
	): Promise<TargetRouterDelegate | null> {
		for (const delegate of [...this.delegates]) {
			if (!this.isRouteCurrent(sessionId, token)) {
				return null
			}
			if (!this.delegates.includes(delegate)) {
				continue
			}
			token.candidate = delegate
			let claimed = false
			try {
				claimed = await delegate.canClaimTarget(info)
			} catch (err) {
				claimed = false
				this.log({
					category: "target-router",
					message: "Target ownership predicate failed",
					level: LogLevel.Debug,
					attributes: {
						targetId: info.targetId,
						error: errorMessage(err),
					},
				})
			}
			if (!this.isRouteCurrent(sessionId, token)) {
				return null
			}
			token.candidate = undefined
			if (claimed) {
				return delegate
			}
		}
		return null
	}

	private async resumeAndDetach(sessionId: SessionId): Promise<void> {
		const controller = new AbortController()
		const timer = setTimeout(
			() => controller.abort(new Error("Target router cleanup timed out")),
			1000,
		)
		const session = this.conn.getSession(sessionId)
		try {
			if (session) {
				try {
					const queued = queueCDPCommand(
						this.conn,
						session,
						"Runtime.runIfWaitingForDebugger",
						controller.signal,
					)
					void queued.response.catch(() => {})
					await queued.dispatched.catch(() => {})
				} catch {}
			}
			await sendCDPWithSignal(
				this.conn,
				"Target.detachFromTarget",
				controller.signal,
				{ sessionId },
			).catch(() => {})
		} finally {
			clearTimeout(timer)
		}
	}
}

const routers = new WeakMap<CDPConnectionLike, TargetRouter>()

export function getTargetRouter(conn: CDPConnectionLike): TargetRouter {
	return TargetRouter.forConnection(conn)
}
