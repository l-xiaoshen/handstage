import type { Protocol } from "devtools-protocol"
import { v3Logger } from "../logger"
import { LogLevel } from "../types/public/logs"
import type { CDPConnectionLike } from "./cdp"

type SessionId = string
type TargetId = string

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
 * CDP auto-attach is browser-wide for a websocket.  If each V3Context installs
 * its own Target listeners and independently filters by browserContextId, a
 * foreign target can remain paused by `waitForDebuggerOnStart` when the context
 * that saw it decides it is out-of-scope.  TargetRouter makes ownership a
 * single connection-level decision: exactly one registered context receives a
 * target, and every unclaimed session is immediately resumed and detached.
 */
export class TargetRouter {
	private delegates: TargetRouterDelegate[] = []
	private sessionOwners = new Map<SessionId, TargetRouterDelegate>()
	private started = false
	private closed = false
	private startPromise: Promise<void> | null = null

	private constructor(private readonly conn: CDPConnectionLike) {}

	public static forConnection(conn: CDPConnectionLike): TargetRouter {
		let router = routers.get(conn)
		if (!router) {
			router = new TargetRouter(conn)
			routers.set(conn, router)
		}
		return router
	}

	public async register(delegate: TargetRouterDelegate): Promise<() => void> {
		if (this.closed) {
			throw new Error("Cannot register a context on a closed TargetRouter")
		}
		if (!this.delegates.includes(delegate)) {
			this.delegates.push(delegate)
		}
		await this.start()
		return () => this.unregister(delegate)
	}

	public unregister(delegate: TargetRouterDelegate): void {
		this.delegates = this.delegates.filter((d) => d !== delegate)
		for (const [sessionId, owner] of [...this.sessionOwners.entries()]) {
			if (owner === delegate) this.sessionOwners.delete(sessionId)
		}

		// Keep the root Target listeners installed even with zero delegates.
		// Auto-attach is browser-wide and remains enabled on the connection; a
		// future target must still be resumed/detached rather than left paused.
	}

	private async start(): Promise<void> {
		if (this.started) return
		if (this.startPromise) return this.startPromise

		this.startPromise = (async () => {
			this.conn.on("Target.attachedToTarget", this.onAttachedToTarget)
			this.conn.on("Target.detachedFromTarget", this.onDetachedFromTarget)
			this.conn.on("Target.targetDestroyed", this.onTargetDestroyed)

			try {
				await this.conn.enableAutoAttach()
				this.started = true
			} catch (err) {
				this.stop()
				throw err
			}
		})()

		try {
			await this.startPromise
		} finally {
			this.startPromise = null
		}
	}

	private stop(): void {
		if (!this.started && !this.startPromise) return
		this.conn.off("Target.attachedToTarget", this.onAttachedToTarget)
		this.conn.off("Target.detachedFromTarget", this.onDetachedFromTarget)
		this.conn.off("Target.targetDestroyed", this.onTargetDestroyed)
		this.sessionOwners.clear()
		this.started = false
	}

	private onAttachedToTarget = (
		evt: Protocol.Target.AttachedToTargetEvent,
	): void => {
		void this.routeAttached(evt).catch((err) => {
			v3Logger({
				category: "target-router",
				message: "Target attach routing failed",
				level: LogLevel.Debug,
				attributes: {
					targetId: evt?.targetInfo?.targetId,
					sessionId: evt?.sessionId,
					error: err instanceof Error ? err.message : String(err),
				},
			})
			void this.resumeAndDetach(evt.sessionId)
		})
	}

	private async routeAttached(
		evt: Protocol.Target.AttachedToTargetEvent,
	): Promise<void> {
		if (this.closed) {
			await this.resumeAndDetach(evt.sessionId)
			return
		}

		const owner = await this.findOwner(evt.targetInfo)
		if (!owner) {
			await this.resumeAndDetach(evt.sessionId)
			return
		}

		this.sessionOwners.set(evt.sessionId, owner)
		await owner.onRouterAttachedToTarget(evt.targetInfo, evt.sessionId)
	}

	private onDetachedFromTarget = (
		evt: Protocol.Target.DetachedFromTargetEvent,
	): void => {
		const owner = this.sessionOwners.get(evt.sessionId)
		this.sessionOwners.delete(evt.sessionId)
		if (owner) {
			owner.onRouterDetachedFromTarget(evt.sessionId, evt.targetId ?? null)
			return
		}

		for (const delegate of this.delegates) {
			delegate.onRouterDetachedFromTarget(evt.sessionId, evt.targetId ?? null)
		}
	}

	private onTargetDestroyed = (
		evt: Protocol.Target.TargetDestroyedEvent,
	): void => {
		for (const delegate of this.delegates) {
			delegate.onRouterTargetDestroyed(evt.targetId)
		}
	}

	private async findOwner(
		info: Protocol.Target.TargetInfo,
	): Promise<TargetRouterDelegate | null> {
		for (const delegate of this.delegates) {
			let claimed = false
			try {
				claimed = await delegate.canClaimTarget(info)
			} catch (err) {
				v3Logger({
					category: "target-router",
					message: "Target ownership predicate failed",
					level: LogLevel.Debug,
					attributes: {
						targetId: info.targetId,
						error: err instanceof Error ? err.message : String(err),
					},
				})
			}
			if (claimed) return delegate
		}
		return null
	}

	private async resumeAndDetach(sessionId: SessionId): Promise<void> {
		const session = this.conn.getSession(sessionId)
		if (!session) return

		await session.send("Runtime.runIfWaitingForDebugger").catch(() => {})
		await this.conn
			.send("Target.detachFromTarget", { sessionId })
			.catch(() => {})
	}
}

const routers = new WeakMap<CDPConnectionLike, TargetRouter>()

export function getTargetRouter(conn: CDPConnectionLike): TargetRouter {
	return TargetRouter.forConnection(conn)
}
