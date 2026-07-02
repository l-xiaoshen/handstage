import type { Protocol } from "devtools-protocol"
import type { CDPSessionLike } from "./cdp"

type FrameId = Protocol.Page.FrameId
type ExecId = Protocol.Runtime.ExecutionContextId

export class ExecutionContextRegistry {
	private readonly byFrame = new WeakMap<CDPSessionLike, Map<FrameId, ExecId>>()
	private readonly byExec = new WeakMap<CDPSessionLike, Map<ExecId, FrameId>>()

	/**
	 * Isolated worlds created via `Page.createIsolatedWorld`, keyed by
	 * `${frameId}:${worldName}`. Chrome makes a new context on every call
	 * (worldName isn't a dedup key), so we create each world once and reuse it,
	 * evicting on context destroy/clear (see {@link attachSession}).
	 */
	private readonly isolatedByFrame = new WeakMap<
		CDPSessionLike,
		Map<string, ExecId>
	>()
	private readonly isolatedExecKey = new WeakMap<
		CDPSessionLike,
		Map<ExecId, string>
	>()

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
			// Main-world mapping.
			const rev = this.byExec.get(session)
			const fwd = this.byFrame.get(session)
			if (rev && fwd) {
				const frameId = rev.get(evt.executionContextId)
				if (frameId) {
					rev.delete(evt.executionContextId)
					if (fwd.get(frameId) === evt.executionContextId) fwd.delete(frameId)
				}
			}

			// Isolated-world cache: evict so the next resolve recreates the world
			// instead of evaluating against a destroyed context.
			const irev = this.isolatedExecKey.get(session)
			const ifwd = this.isolatedByFrame.get(session)
			if (irev && ifwd) {
				const key = irev.get(evt.executionContextId)
				if (key !== undefined) {
					irev.delete(evt.executionContextId)
					if (ifwd.get(key) === evt.executionContextId) ifwd.delete(key)
				}
			}
		}
		const onCleared = (): void => {
			this.byFrame.delete(session)
			this.byExec.delete(session)
			this.isolatedByFrame.delete(session)
			this.isolatedExecKey.delete(session)
		}

		session.on("Runtime.executionContextCreated", onCreated)
		session.on("Runtime.executionContextDestroyed", onDestroyed)
		session.on("Runtime.executionContextsCleared", onCleared)

		return () => {
			session.off("Runtime.executionContextCreated", onCreated)
			session.off("Runtime.executionContextDestroyed", onDestroyed)
			session.off("Runtime.executionContextsCleared", onCleared)
		}
	}

	getMainWorld(session: CDPSessionLike, frameId: FrameId): ExecId | null {
		return this.byFrame.get(session)?.get(frameId) ?? null
	}

	/**
	 * Cached isolated-world context id for `(session, frameId, worldName)`,
	 * created via `Page.createIsolatedWorld` at most once and evicted by the
	 * destroy/clear handlers in {@link attachSession} so a post-navigation call
	 * recreates it. A stale id (if `attachSession` wasn't active) only makes the
	 * evaluate fail and fall back to the main world — never a wrong live context.
	 */
	async getIsolatedWorld(
		session: CDPSessionLike,
		frameId: FrameId,
		worldName: string,
	): Promise<ExecId> {
		const key = `${frameId}:${worldName}`
		const cached = this.isolatedByFrame.get(session)?.get(key)
		if (cached !== undefined) return cached

		const { executionContextId } = await session.send(
			"Page.createIsolatedWorld",
			{ frameId, worldName },
		)

		let fwd = this.isolatedByFrame.get(session)
		if (!fwd) {
			fwd = new Map<string, ExecId>()
			this.isolatedByFrame.set(session, fwd)
		}
		let rev = this.isolatedExecKey.get(session)
		if (!rev) {
			rev = new Map<ExecId, string>()
			this.isolatedExecKey.set(session, rev)
		}
		const prev = fwd.get(key)
		if (prev !== undefined) rev.delete(prev)
		fwd.set(key, executionContextId)
		rev.set(executionContextId, key)
		return executionContextId
	}

	async waitForMainWorld(
		session: CDPSessionLike,
		frameId: FrameId,
		timeoutMs: number = 800,
	): Promise<ExecId> {
		const cached = this.getMainWorld(session, frameId)
		if (cached) return cached

		await session.send("Runtime.enable").catch(() => {})
		const after = this.getMainWorld(session, frameId)
		if (after) return after

		return await new Promise<ExecId>((resolve, reject) => {
			let done = false
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
						clearTimeout(timer)
						session.off("Runtime.executionContextCreated", onCreated)
						resolve(evt.context.id)
					}
				}
			}
			const timer = setTimeout(() => {
				if (!done) {
					done = true
					session.off("Runtime.executionContextCreated", onCreated)
					reject(new Error(`main world not ready for frame ${frameId}`))
				}
			}, timeoutMs)
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
