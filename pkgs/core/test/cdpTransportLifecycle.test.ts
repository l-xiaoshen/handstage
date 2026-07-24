/**
 * Regression tests for CDP and transport resource lifecycle behavior.
 */
import { describe, expect, test } from "bun:test"
import { withTimeout } from "../src/v3/timeoutConfig"
import {
	CDPConnectionClosedError,
	HandstageTransportAlreadyOwnedError,
} from "../src/v3/types/public/sdkErrors"
import {
	type CDPCommand,
	type CDPCommandParams,
	type CDPCommandResult,
	CDPConnection,
	type CDPEvent,
	type CDPEventParams,
	createWebSocketTransport,
	type ExternalCDPSession,
	ExternalConnectionAdapter,
	ExternalSessionAdapter,
} from "../src/v3/understudy/cdp"
import { FakeSession, InMemoryTransport, pageTarget, waitFor } from "./_fakes"

describe("CDPConnection.close settles pending work", () => {
	test("in-flight commands reject instead of hanging", async () => {
		// InMemoryTransport never replies to Page.enable.
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)

		const inflight = conn.send("Page.enable")
		await conn.close()

		await expect(inflight).rejects.toBeInstanceOf(CDPConnectionClosedError)
	})

	test("session dispatch waiters reject on close", async () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)

		const waiter = conn.waitForSessionDispatch("session-x", "Page.enable")
		await conn.close()

		await expect(waiter).rejects.toBeInstanceOf(CDPConnectionClosedError)
	})

	test("aborted commands are removed from the inflight map", async () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)
		const abortController = new AbortController()
		const pending = conn.sendWithSignal("Page.enable", abortController.signal)
		abortController.abort(new Error("cancelled"))

		await expect(pending).rejects.toThrow("cancelled")
		const internals = conn as unknown as {
			inflight: Map<number, unknown>
		}
		expect(internals.inflight.size).toBe(0)
		await conn.close()
	})

	test("synchronous transport send failures do not retain inflight work", async () => {
		const transport = new InMemoryTransport()
		transport.send = () => {
			throw new Error("send failed")
		}
		const conn = new CDPConnection(transport)

		await expect(conn.send("Page.enable")).rejects.toThrow("send failed")
		const internals = conn as unknown as {
			inflight: Map<number, unknown>
		}
		expect(internals.inflight.size).toBe(0)
		await conn.close()
	})

	test("close clears retained state and is idempotent", async () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)
		const session = new FakeSession("s-close")
		const onLoad = () => {}
		let closeNotifications = 0

		conn.on("Page.loadEventFired", onLoad)
		conn.onTransportClosed(() => {
			closeNotifications += 1
		})

		const internals = conn as unknown as {
			sessions: Map<string, FakeSession>
			sessionToTarget: Map<string, string>
			eventHandlers: Map<string, Set<unknown>>
			transportCloseHandlers: Set<(why: string) => void>
		}
		internals.sessions.set(session.id, session)
		internals.sessionToTarget.set(session.id, "t-close")

		await Promise.all([conn.close(), conn.close()])

		expect(transport.closeCalls).toBe(1)
		expect(closeNotifications).toBe(1)
		expect(internals.sessions.size).toBe(0)
		expect(internals.sessionToTarget.size).toBe(0)
		expect(internals.eventHandlers.size).toBe(0)
		expect(internals.transportCloseHandlers.size).toBe(0)
		expect(transport.onmessage).toBeUndefined()
		expect(transport.onclose).toBeUndefined()
		expect(transport.onerror).toBeUndefined()
		await expect(
			conn.waitForSessionDispatch("late-session", "Page.enable"),
		).rejects.toBeInstanceOf(CDPConnectionClosedError)
		expect(() => conn.on("Page.loadEventFired", () => {})).toThrow(
			CDPConnectionClosedError,
		)
		expect(internals.eventHandlers.size).toBe(0)
	})

	test("targetDestroyed releases session state without a detach event", async () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)
		transport.onmessage?.(
			JSON.stringify({
				method: "Target.attachedToTarget",
				params: {
					sessionId: "s-destroyed",
					targetInfo: pageTarget("t-destroyed"),
					waitingForDebugger: false,
				},
			}),
		)
		const session = conn.getSession("s-destroyed")
		if (!session) {
			throw new Error("expected attached session")
		}
		session.on("Page.loadEventFired", () => {})
		const pending = session.send("Page.enable")

		transport.onmessage?.(
			JSON.stringify({
				method: "Target.targetDestroyed",
				params: { targetId: "t-destroyed" },
			}),
		)

		await expect(pending).rejects.toThrow("target closed")
		expect(conn.getSession("s-destroyed")).toBeUndefined()
		const internals = conn as unknown as {
			eventHandlers: Map<string, Set<unknown>>
		}
		expect(
			[...internals.eventHandlers.keys()].some((key) =>
				key.startsWith("s-destroyed:"),
			),
		).toBe(false)
		await conn.close()
	})

	test("protocol errors close the transport and reject pending commands", async () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)
		const pending = conn.send("Page.enable")

		expect(() => transport.onmessage?.("not-json")).not.toThrow()

		await expect(pending).rejects.toBeInstanceOf(CDPConnectionClosedError)
		await waitFor(() => transport.closeCalls === 1)
	})

	test("transport errors actively close the owned transport", async () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)

		transport.onerror?.(new Error("pipe failed"))

		await waitFor(() => transport.closeCalls === 1)
		await expect(conn.send("Page.enable")).rejects.toBeInstanceOf(
			CDPConnectionClosedError,
		)
	})

	test("a detached attach response cannot recreate its session", async () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)
		const attaching = conn.attachToTarget("t-racy")
		const request = JSON.parse(transport.sent.at(-1) ?? "{}") as { id: number }

		transport.onmessage?.(
			JSON.stringify({
				method: "Target.attachedToTarget",
				params: {
					sessionId: "s-racy",
					targetInfo: pageTarget("t-racy"),
					waitingForDebugger: true,
				},
			}),
		)
		transport.onmessage?.(
			JSON.stringify({
				method: "Target.detachedFromTarget",
				params: { sessionId: "s-racy", targetId: "t-racy" },
			}),
		)
		transport.onmessage?.(
			JSON.stringify({ id: request.id, result: { sessionId: "s-racy" } }),
		)

		await expect(attaching).rejects.toThrow("closed before attach completed")
		expect(conn.getSession("s-racy")).toBeUndefined()
		await conn.close()
	})

	test("captured post-close callbacks cannot repopulate session maps", async () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)
		const captured = transport.onmessage
		await conn.close()

		captured?.(
			JSON.stringify({
				method: "Target.attachedToTarget",
				params: {
					sessionId: "s-late",
					targetInfo: pageTarget("t-late"),
					waitingForDebugger: true,
				},
			}),
		)

		expect(conn.getSession("s-late")).toBeUndefined()
	})

	test("partial auto-attach setup is rolled back", async () => {
		class PartialAutoAttachTransport extends InMemoryTransport {
			override send(message: string): void {
				this.sent.push(message)
				const request = JSON.parse(message) as {
					id: number
					method: string
					params?: unknown
				}
				queueMicrotask(() => {
					if (request.method === "Target.setDiscoverTargets") {
						this.onmessage?.(
							JSON.stringify({
								id: request.id,
								error: { code: -1, message: "discover failed" },
							}),
						)
						return
					}
					this.onmessage?.(JSON.stringify({ id: request.id, result: {} }))
				})
			}
		}

		const transport = new PartialAutoAttachTransport()
		const conn = new CDPConnection(transport)
		await expect(conn.enableAutoAttach()).rejects.toThrow("discover failed")
		const autoAttachRequests = transport.sent
			.map(
				(message) => JSON.parse(message) as { method: string; params: unknown },
			)
			.filter((request) => request.method === "Target.setAutoAttach")
		expect(autoAttachRequests).toHaveLength(2)
		expect(autoAttachRequests[1]?.params).toMatchObject({
			autoAttach: false,
			waitForDebuggerOnStart: false,
		})
		await conn.close()
	})
})

describe("WebSocket transport ownership", () => {
	class FakeWebSocket {
		private listeners = new Map<string, Set<EventListener>>()
		public closeCalls = 0

		addEventListener(type: string, listener: EventListener): void {
			const handlers = this.listeners.get(type) ?? new Set()
			handlers.add(listener)
			this.listeners.set(type, handlers)
		}

		removeEventListener(type: string, listener: EventListener): void {
			this.listeners.get(type)?.delete(listener)
		}

		send(): void {}

		close(): void {
			this.closeCalls += 1
		}

		listenerCount(): number {
			let count = 0
			for (const handlers of this.listeners.values()) {
				count += handlers.size
			}
			return count
		}
	}

	test("one socket has one owner and releases listeners on close", async () => {
		const socket = new FakeWebSocket()
		const ws = socket as unknown as WebSocket
		const first = createWebSocketTransport(ws)

		expect(() => createWebSocketTransport(ws)).toThrow(
			HandstageTransportAlreadyOwnedError,
		)
		expect(socket.listenerCount()).toBe(3)

		await first.close()
		expect(socket.listenerCount()).toBe(0)

		const second = createWebSocketTransport(ws)
		await second.close()
		expect(socket.listenerCount()).toBe(0)
	})
})

describe("ExternalConnectionAdapter root listener lifecycle", () => {
	class FakeExternalSession implements ExternalCDPSession {
		public readonly id: string | null = null
		public onclose?: (reason: string) => void
		public closeCalls = 0
		private handlers = new Map<string, Set<(params: unknown) => void>>()

		send<M extends CDPCommand>(
			_method: M,
			..._params: CDPCommandParams<M>
		): Promise<CDPCommandResult<M>> {
			return Promise.resolve({} as CDPCommandResult<M>)
		}

		on<E extends CDPEvent>(
			event: E,
			handler: (params: CDPEventParams<E>) => void,
		): void {
			const set = this.handlers.get(event) ?? new Set()
			set.add(handler as (params: unknown) => void)
			this.handlers.set(event, set)
		}

		off<E extends CDPEvent>(
			event: E,
			handler: (params: CDPEventParams<E>) => void,
		): void {
			this.handlers.get(event)?.delete(handler as (params: unknown) => void)
		}

		handlerCount(event: string): number {
			return this.handlers.get(event)?.size ?? 0
		}

		emit(event: string, params: unknown): void {
			for (const handler of this.handlers.get(event) ?? []) {
				handler(params)
			}
		}

		async close(): Promise<void> {
			this.closeCalls += 1
		}
	}

	test("off() removes the fan-out listener from the external session", async () => {
		const external = new FakeExternalSession()
		const previousOnClose = () => {}
		external.onclose = previousOnClose
		const adapter = new ExternalConnectionAdapter(external)
		const handler = () => {}
		let closeNotifications = 0
		adapter.onTransportClosed(() => {
			closeNotifications += 1
		})

		adapter.on("Network.loadingFinished", handler)
		expect(external.handlerCount("Network.loadingFinished")).toBe(1)

		adapter.off("Network.loadingFinished", handler)
		expect(external.handlerCount("Network.loadingFinished")).toBe(0)

		// Re-subscribing must re-install the root listener.
		adapter.on("Network.loadingFinished", handler)
		expect(external.handlerCount("Network.loadingFinished")).toBe(1)

		await Promise.all([adapter.close(), adapter.close()])
		expect(external.handlerCount("Network.loadingFinished")).toBe(0)
		expect(closeNotifications).toBe(1)
		expect(external.closeCalls).toBe(1)
		expect(external.onclose).toBe(previousOnClose)
		await expect(adapter.send("Page.enable")).rejects.toBeInstanceOf(
			CDPConnectionClosedError,
		)
		expect(() => adapter.on("Page.loadEventFired", () => {})).toThrow(
			CDPConnectionClosedError,
		)
	})

	test("unsupported child sends reject dispatch waiters", async () => {
		const external = new FakeExternalSession()
		const adapter = new ExternalConnectionAdapter(external)
		const child = new ExternalSessionAdapter(adapter, "s-external-child")
		const dispatched = adapter.waitForSessionDispatch(child.id, "Page.enable")
		const results = await Promise.allSettled([
			child.send("Page.enable"),
			dispatched,
		])
		expect(results[0]?.status).toBe("rejected")
		expect(results[1]?.status).toBe("rejected")
		expect(String((results[1] as PromiseRejectedResult).reason)).toContain(
			"does not support child target",
		)
		await adapter.close()
	})

	test("target destruction removes external child session state", async () => {
		const external = new FakeExternalSession()
		const adapter = new ExternalConnectionAdapter(external)
		external.emit("Target.attachedToTarget", {
			sessionId: "s-external-destroy",
			targetInfo: pageTarget("t-external-destroy"),
		})
		expect(adapter.getSession("s-external-destroy")).toBeDefined()

		external.emit("Target.targetDestroyed", {
			targetId: "t-external-destroy",
		})

		expect(adapter.getSession("s-external-destroy")).toBeUndefined()
		await adapter.close()
	})

	test("external close settles delegated commands that never respond", async () => {
		class NeverRespondingSession extends FakeExternalSession {
			override send<M extends CDPCommand>(
				_method: M,
				..._params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				return new Promise<CDPCommandResult<M>>(() => {})
			}
		}

		const external = new NeverRespondingSession()
		const adapter = new ExternalConnectionAdapter(external)
		const pending = adapter.send("Page.enable")

		external.onclose?.("closed by owner")

		await expect(
			withTimeout(pending, 100, "external pending command"),
		).rejects.toBeInstanceOf(CDPConnectionClosedError)
	})
})
