import type { Protocol } from "devtools-protocol"
import type { CDPSessionLike } from "./cdp"

type FrameId = Protocol.Page.FrameId
type ExecId = Protocol.Runtime.ExecutionContextId

export class ExecutionContextRegistry {
	private readonly byFrame = new WeakMap<CDPSessionLike, Map<FrameId, ExecId>>()
	private readonly byExec = new WeakMap<CDPSessionLike, Map<ExecId, FrameId>>()
	private readonly pendingWaits = new WeakMap<
		CDPSessionLike,
		Set<(error: Error) => void>
	>()
	private readonly detachedSessions = new WeakSet<CDPSessionLike>()

	/**
	 * Wire listeners for this session. Call BEFORE Runtime.enable.
	 *
	 * Returns a disposer that removes every listener installed by this
	 * call.  Callers (notably `Context`) must invoke the disposer when
	 * the session is detached or the owning context closes; otherwise
	 * the connection's per-session event-handler map accumulates entries
	 * keyed by `${sessionId}:Runtime.*` for the connection's lifetime.
	 */
	attachSession(session: CDPSessionLike): () => void {
		this.detachedSessions.delete(session)
		const onCreated = (
			evt: Protocol.Runtime.ExecutionContextCreatedEvent,
		): void => {
			const aux = (evt.context.auxData ?? {}) as {
				frameId?: string
				isDefault?: boolean
			}
			if (aux.isDefault === true && typeof aux.frameId === "string") {
				this.register(session, aux.frameId as FrameId, evt.context.id)
			}
		}
		const onDestroyed = (
			evt: Protocol.Runtime.ExecutionContextDestroyedEvent,
		): void => {
			const rev = this.byExec.get(session)
			const fwd = this.byFrame.get(session)
			if (!rev || !fwd) return
			const frameId = rev.get(evt.executionContextId)
			if (!frameId) return
			rev.delete(evt.executionContextId)
			if (fwd.get(frameId) === evt.executionContextId) fwd.delete(frameId)
		}
		const onCleared = (): void => {
			this.byFrame.delete(session)
			this.byExec.delete(session)
		}

		session.on("Runtime.executionContextCreated", onCreated)
		session.on("Runtime.executionContextDestroyed", onDestroyed)
		session.on("Runtime.executionContextsCleared", onCleared)

		return () => {
			session.off("Runtime.executionContextCreated", onCreated)
			session.off("Runtime.executionContextDestroyed", onDestroyed)
			session.off("Runtime.executionContextsCleared", onCleared)
			this.detachSession(session)
		}
	}

	private detachSession(session: CDPSessionLike): void {
		this.detachedSessions.add(session)
		this.byFrame.delete(session)
		this.byExec.delete(session)
		const waits = this.pendingWaits.get(session)
		if (!waits) return
		this.pendingWaits.delete(session)
		for (const cancel of [...waits]) {
			cancel(new Error(`session ${session.id ?? "root"} detached`))
		}
	}

	getMainWorld(session: CDPSessionLike, frameId: FrameId): ExecId | null {
		return this.byFrame.get(session)?.get(frameId) ?? null
	}

	async waitForMainWorld(
		session: CDPSessionLike,
		frameId: FrameId,
		timeoutMs: number = 800,
	): Promise<ExecId> {
		if (this.detachedSessions.has(session)) {
			throw new Error(`session ${session.id ?? "root"} detached`)
		}
		const cached = this.getMainWorld(session, frameId)
		if (cached) return cached

		await session.send("Runtime.enable").catch(() => {})
		if (this.detachedSessions.has(session)) {
			throw new Error(`session ${session.id ?? "root"} detached`)
		}
		const after = this.getMainWorld(session, frameId)
		if (after) return after

		return await new Promise<ExecId>((resolve, reject) => {
			let done = false
			let waits = this.pendingWaits.get(session)
			if (!waits) {
				waits = new Set()
				this.pendingWaits.set(session, waits)
			}
			const cleanup = () => {
				clearTimeout(timer)
				session.off("Runtime.executionContextCreated", onCreated)
				waits?.delete(cancel)
				if (waits?.size === 0) this.pendingWaits.delete(session)
			}
			const cancel = (error: Error) => {
				if (done) return
				done = true
				cleanup()
				reject(error)
			}
			const onCreated = (
				evt: Protocol.Runtime.ExecutionContextCreatedEvent,
			): void => {
				const aux = (evt.context.auxData ?? {}) as {
					frameId?: string
					isDefault?: boolean
				}
				if (aux.isDefault === true && aux.frameId === frameId) {
					this.register(session, frameId, evt.context.id)
					if (!done) {
						done = true
						cleanup()
						resolve(evt.context.id)
					}
				}
			}
			const timer = setTimeout(() => {
				cancel(new Error(`main world not ready for frame ${frameId}`))
			}, timeoutMs)
			waits.add(cancel)
			session.on("Runtime.executionContextCreated", onCreated)
		})
	}

	private register(
		session: CDPSessionLike,
		frameId: FrameId,
		ctxId: ExecId,
	): void {
		let fwd = this.byFrame.get(session)
		if (!fwd) {
			fwd = new Map<FrameId, ExecId>()
			this.byFrame.set(session, fwd)
		}
		let rev = this.byExec.get(session)
		if (!rev) {
			rev = new Map<ExecId, FrameId>()
			this.byExec.set(session, rev)
		}
		fwd.set(frameId, ctxId)
		rev.set(ctxId, frameId)
	}
}

export const executionContexts = new ExecutionContextRegistry()
