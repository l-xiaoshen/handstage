import type { Protocol } from "devtools-protocol"
import { type CDPSessionLike, sendCDPWithSignal } from "./cdp"

type FrameId = Protocol.Page.FrameId
type ExecId = Protocol.Runtime.ExecutionContextId

function defaultFrameId(
	context: Protocol.Runtime.ExecutionContextDescription,
): FrameId | null {
	const aux = context.auxData
	if (
		typeof aux !== "object" ||
		aux === null ||
		!("isDefault" in aux) ||
		aux.isDefault !== true ||
		!("frameId" in aux) ||
		typeof aux.frameId !== "string"
	) {
		return null
	}
	return aux.frameId
}

export class ExecutionContextRegistry {
	private readonly byFrame = new WeakMap<CDPSessionLike, Map<FrameId, ExecId>>()
	private readonly byExec = new WeakMap<CDPSessionLike, Map<ExecId, FrameId>>()
	private readonly pendingWaits = new WeakMap<
		CDPSessionLike,
		Set<(error: Error) => void>
	>()
	private readonly detachedSessions = new WeakSet<CDPSessionLike>()
	private readonly sessionGenerations = new WeakMap<CDPSessionLike, number>()

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
		const generation = (this.sessionGenerations.get(session) ?? 0) + 1
		this.sessionGenerations.set(session, generation)
		this.clearSessionState(
			session,
			new Error(`session ${session.id ?? "root"} reattached`),
		)
		this.detachedSessions.delete(session)
		const isActive = () =>
			!this.detachedSessions.has(session) &&
			this.sessionGenerations.get(session) === generation
		const onCreated = (
			evt: Protocol.Runtime.ExecutionContextCreatedEvent,
		): void => {
			if (!isActive()) {
				return
			}
			const frameId = defaultFrameId(evt.context)
			if (frameId) {
				this.register(session, frameId, evt.context.id, generation)
			}
		}
		const onDestroyed = (
			evt: Protocol.Runtime.ExecutionContextDestroyedEvent,
		): void => {
			if (!isActive()) {
				return
			}
			const rev = this.byExec.get(session)
			const fwd = this.byFrame.get(session)
			if (!rev || !fwd) {
				return
			}
			const frameId = rev.get(evt.executionContextId)
			if (!frameId) {
				return
			}
			rev.delete(evt.executionContextId)
			if (fwd.get(frameId) === evt.executionContextId) {
				fwd.delete(frameId)
			}
		}
		const onCleared = (): void => {
			if (!isActive()) {
				return
			}
			this.byFrame.delete(session)
			this.byExec.delete(session)
		}

		let listeningCreated = false
		let listeningDestroyed = false
		let listeningCleared = false
		const removeListeners = () => {
			if (listeningCreated) {
				listeningCreated = false
				try {
					session.off("Runtime.executionContextCreated", onCreated)
				} catch {}
			}
			if (listeningDestroyed) {
				listeningDestroyed = false
				try {
					session.off("Runtime.executionContextDestroyed", onDestroyed)
				} catch {}
			}
			if (listeningCleared) {
				listeningCleared = false
				try {
					session.off("Runtime.executionContextsCleared", onCleared)
				} catch {}
			}
		}
		try {
			listeningCreated = true
			session.on("Runtime.executionContextCreated", onCreated)
			listeningDestroyed = true
			session.on("Runtime.executionContextDestroyed", onDestroyed)
			listeningCleared = true
			session.on("Runtime.executionContextsCleared", onCleared)
		} catch (error) {
			removeListeners()
			if (this.sessionGenerations.get(session) === generation) {
				this.sessionGenerations.set(session, generation + 1)
				this.detachSession(session)
			}
			throw error
		}

		let disposed = false
		return () => {
			if (disposed) {
				return
			}
			disposed = true
			removeListeners()
			if (this.sessionGenerations.get(session) === generation) {
				this.sessionGenerations.set(session, generation + 1)
				this.detachSession(session)
			}
		}
	}

	private detachSession(session: CDPSessionLike): void {
		this.detachedSessions.add(session)
		this.clearSessionState(
			session,
			new Error(`session ${session.id ?? "root"} detached`),
		)
	}

	private clearSessionState(session: CDPSessionLike, error: Error): void {
		this.byFrame.delete(session)
		this.byExec.delete(session)
		const waits = this.pendingWaits.get(session)
		if (!waits) {
			return
		}
		this.pendingWaits.delete(session)
		for (const cancel of [...waits]) {
			cancel(error)
		}
	}

	getMainWorld(session: CDPSessionLike, frameId: FrameId): ExecId | null {
		return this.byFrame.get(session)?.get(frameId) ?? null
	}

	async waitForMainWorld(
		session: CDPSessionLike,
		frameId: FrameId,
		timeoutMs: number = 800,
		signal?: AbortSignal,
	): Promise<ExecId> {
		const generation = this.sessionGenerations.get(session) ?? 0
		const isActive = () =>
			!this.detachedSessions.has(session) &&
			(this.sessionGenerations.get(session) ?? 0) === generation
		if (signal?.aborted) {
			throw signal.reason instanceof Error
				? signal.reason
				: new Error("execution-context wait aborted")
		}
		if (this.detachedSessions.has(session)) {
			throw new Error(`session ${session.id ?? "root"} detached`)
		}
		const cached = this.getMainWorld(session, frameId)
		if (cached) {
			return cached
		}

		if (signal) {
			await sendCDPWithSignal(session, "Runtime.enable", signal).catch(
				(error) => {
					if (signal.aborted) {
						throw error
					}
				},
			)
		} else {
			await session.send("Runtime.enable").catch(() => {})
		}
		if (!isActive()) {
			throw new Error(`session ${session.id ?? "root"} detached`)
		}
		const after = this.getMainWorld(session, frameId)
		if (after) {
			return after
		}

		return await new Promise<ExecId>((resolve, reject) => {
			let done = false
			let waits = this.pendingWaits.get(session)
			if (!waits) {
				waits = new Set()
				this.pendingWaits.set(session, waits)
			}
			const cleanup = () => {
				clearTimeout(timer)
				try {
					session.off("Runtime.executionContextCreated", onCreated)
				} catch {}
				waits?.delete(cancel)
				if (waits?.size === 0) {
					this.pendingWaits.delete(session)
				}
				signal?.removeEventListener("abort", onAbort)
			}
			const cancel = (error: Error) => {
				if (done) {
					return
				}
				done = true
				cleanup()
				reject(error)
			}
			const onAbort = () => {
				cancel(
					signal?.reason instanceof Error
						? signal.reason
						: new Error("execution-context wait aborted"),
				)
			}
			const onCreated = (
				evt: Protocol.Runtime.ExecutionContextCreatedEvent,
			): void => {
				if (done || !isActive()) {
					return
				}
				if (defaultFrameId(evt.context) === frameId) {
					this.register(session, frameId, evt.context.id, generation)
					done = true
					cleanup()
					resolve(evt.context.id)
				}
			}
			const timer = setTimeout(() => {
				cancel(new Error(`main world not ready for frame ${frameId}`))
			}, timeoutMs)
			waits.add(cancel)
			signal?.addEventListener("abort", onAbort, { once: true })
			if (signal?.aborted) {
				onAbort()
				return
			}
			if (!isActive()) {
				cancel(new Error(`session ${session.id ?? "root"} detached`))
				return
			}
			try {
				session.on("Runtime.executionContextCreated", onCreated)
			} catch (error) {
				cancel(error instanceof Error ? error : new Error(String(error)))
			}
		})
	}

	private register(
		session: CDPSessionLike,
		frameId: FrameId,
		ctxId: ExecId,
		generation: number,
	): void {
		if (
			this.detachedSessions.has(session) ||
			(this.sessionGenerations.get(session) ?? 0) !== generation
		) {
			return
		}
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
