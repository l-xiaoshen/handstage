/**
 * Regression tests for resource-lifecycle fixes: close/dispose paths must
 * settle pending promises, remove listeners, and prune frame-keyed caches.
 */
import { describe, expect, test } from "bun:test"
import { connectConnection } from "../src/v3/connect/connection"
import { connectTransport } from "../src/v3/connect/transport"
import { withTimeout } from "../src/v3/timeoutConfig"
import {
	CDPConnectionClosedError,
	HandstageTransportAlreadyOwnedError,
} from "../src/v3/types/public/sdkErrors"
import { a11yForFrame } from "../src/v3/understudy/a11y/snapshot/a11yTree"
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
import { Context } from "../src/v3/understudy/context"
import { executionContexts } from "../src/v3/understudy/executionContextRegistry"
import { Frame } from "../src/v3/understudy/frame"
import { FrameRegistry } from "../src/v3/understudy/frameRegistry"
import { LifecycleWatcher } from "../src/v3/understudy/lifecycleWatcher"
import { NavigationResponseTracker } from "../src/v3/understudy/navigationResponseTracker"
import { NetworkManager } from "../src/v3/understudy/networkManager"
import type { Page as PageType } from "../src/v3/understudy/page"
import { Page } from "../src/v3/understudy/page"
import { FrameSelectorResolver } from "../src/v3/understudy/selectorResolver"
import {
	getTargetRouter,
	type TargetRouterDelegate,
} from "../src/v3/understudy/targetRouter"
import {
	attachedEvent,
	FakeConnection,
	FakeSession,
	InMemoryTransport,
	pageTarget,
	waitFor,
} from "./_fakes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
		if (!session) throw new Error("expected attached session")
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
			for (const handlers of this.listeners.values()) count += handlers.size
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
			for (const handler of this.handlers.get(event) ?? []) handler(params)
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

	test("unsupported child sends still settle dispatch waiters", async () => {
		const external = new FakeExternalSession()
		const adapter = new ExternalConnectionAdapter(external)
		const child = new ExternalSessionAdapter(adapter, "s-external-child")
		const dispatched = adapter.waitForSessionDispatch(child.id, "Page.enable")

		await expect(child.send("Page.enable")).rejects.toThrow(
			"does not support child target",
		)
		await withTimeout(dispatched, 100, "external dispatch")
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
})

describe("Handstage context registry", () => {
	test("closed contexts are dropped from browserContexts()", async () => {
		const transport = new InMemoryTransport()
		const handstage = await connectTransport(transport)

		expect(handstage.browserContexts()).toHaveLength(1)

		const ctx = await handstage.createBrowserContext()
		expect(handstage.browserContexts()).toHaveLength(2)

		await ctx.close()
		expect(handstage.browserContexts()).toHaveLength(1)
		expect(handstage.browserContexts()).not.toContain(ctx)

		await handstage.close()
	})

	class DelayedContextConnection extends FakeConnection {
		private startCreate!: () => void
		private finishCreate: (() => void) | null = null
		public readonly createStarted = new Promise<void>((resolve) => {
			this.startCreate = resolve
		})

		override send<M extends CDPCommand>(
			method: M,
			...params: CDPCommandParams<M>
		): Promise<CDPCommandResult<M>> {
			if (method === "Target.createBrowserContext") {
				this.startCreate()
				return new Promise<CDPCommandResult<M>>((resolve) => {
					this.finishCreate = () =>
						resolve({
							browserContextId: "ctx-race",
						} as CDPCommandResult<M>)
				})
			}
			return super.send(method, ...params)
		}

		releaseCreate(): void {
			this.finishCreate?.()
		}
	}

	test("createBrowserContext cannot race with close()", async () => {
		const conn = new DelayedContextConnection()
		const handstage = await connectConnection(conn)

		const creating = handstage.createBrowserContext()
		const outcome = creating.then(
			() => null,
			(error: unknown) => error,
		)
		await conn.createStarted

		const closing = handstage.close()
		conn.releaseCreate()

		const error = await outcome
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toContain("closed")
		await closing
		expect(handstage.browserContexts()).toHaveLength(0)
		expect(
			conn.sent.some(
				(entry) => entry.method === "Target.disposeBrowserContext",
			),
		).toBe(true)
	})

	test("concurrent close callers share the same cleanup", async () => {
		const transport = new InMemoryTransport()
		let finishClose!: () => void
		const closeGate = new Promise<void>((resolve) => {
			finishClose = resolve
		})
		transport.close = async () => {
			transport.closeCalls += 1
			await closeGate
		}
		const handstage = await connectTransport(transport)

		const first = handstage.close()
		let secondFinished = false
		const second = handstage.close().then(() => {
			secondFinished = true
		})
		await sleep(5)
		expect(secondFinished).toBe(false)

		finishClose()
		await Promise.all([first, second])
		expect(transport.closeCalls).toBe(1)
	})
})

describe("Context close races", () => {
	test("closed contexts reject operations before allocating resources", async () => {
		const conn = new FakeConnection()
		const ctx = await Context.createDefaultFromConnection(conn)
		await ctx.close()
		const createCalls = conn.sent.filter(
			(entry) => entry.method === "Target.createTarget",
		).length

		await expect(ctx.newPage()).rejects.toBeInstanceOf(CDPConnectionClosedError)
		expect(
			conn.sent.filter((entry) => entry.method === "Target.createTarget"),
		).toHaveLength(createCalls)
	})

	test("an in-flight target attach cannot recreate page state after close", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-late-attach")
		let finishFrameTree!: (value: unknown) => void
		const frameTreeResponse = new Promise((resolve) => {
			finishFrameTree = resolve
		})
		session.responses.set("Page.getFrameTree", frameTreeResponse)
		conn.sessions.set(session.id, session)
		const ctx = await Context.createDefaultFromConnection(conn)

		const attaching = ctx.onRouterAttachedToTarget(
			pageTarget("t-late-attach"),
			session.id,
		)
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.getFrameTree"),
		)

		const closing = ctx.close()
		finishFrameTree({
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		await Promise.all([attaching, closing])

		expect(ctx.pages()).toHaveLength(0)
		expect(session.handlerCount("Runtime.executionContextCreated")).toBe(0)
		expect(session.handlerCount("Page.frameAttached")).toBe(0)
		expect(session.handlerCount("Network.requestWillBeSent")).toBe(0)
		expect(
			conn.sent.some(
				(entry) =>
					entry.method === "Target.detachFromTarget" &&
					(entry.params as { sessionId: string }).sessionId === session.id,
			),
		).toBe(true)
	})
})

describe("frame cache pruning", () => {
	test("FrameRegistry.onFrameDetached returns the removed subtree", () => {
		const registry = new FrameRegistry("tgt", "F0")
		registry.onFrameAttached("F1", "F0", "s0")
		registry.onFrameAttached("F2", "F1", "s0")
		registry.onFrameAttached("F3", "F0", "s0")

		const removed = registry.onFrameDetached("F1", "remove")
		expect(removed.sort()).toEqual(["F1", "F2"])
		expect(registry.listAllFrames().sort()).toEqual(["F0", "F3"])

		expect(registry.onFrameDetached("F3", "swap")).toEqual([])
		expect(registry.listAllFrames().sort()).toEqual(["F0", "F3"])
	})

	test("Page prunes ordinals and cached Frames for detached descendants", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-main")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})

		const page = await Page.create(conn, session, "tgt-1", null)
		page.onFrameAttached("F1", "F0", session)
		page.onFrameAttached("F2", "F1", session)

		page.frameForId("F1")
		page.frameForId("F2")
		page.getOrdinal("F0")
		page.getOrdinal("F1")
		page.getOrdinal("F2")

		// F2 is removed implicitly as a descendant of F1.
		page.onFrameDetached("F1", "remove")

		expect(page.listAllFrameIds()).toEqual(["F0"])
		const internals = page as unknown as {
			frameOrdinals: Map<string, number>
			frameCache: Map<string, unknown>
		}
		expect(internals.frameOrdinals.has("F1")).toBe(false)
		expect(internals.frameOrdinals.has("F2")).toBe(false)
		expect(internals.frameCache.has("F1")).toBe(false)
		expect(internals.frameCache.has("F2")).toBe(false)
		expect(internals.frameOrdinals.has("F0")).toBe(true)

		page.disposeResources()
		expect(internals.frameOrdinals.size).toBe(0)
		expect(page.listAllFrameIds()).toHaveLength(0)
	})

	test("Page disposal cancels active lifecycle waits", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-page-wait")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const page = await Page.create(conn, session, "t-page-wait", null)

		const waiting = page.waitForMainLoadState("networkidle", 10_000)
		await waitFor(() => session.handlerCount("Page.lifecycleEvent") > 0)
		page.disposeResources()

		await expect(
			withTimeout(waiting, 100, "page lifecycle disposal"),
		).rejects.toBeInstanceOf(CDPConnectionClosedError)
		expect(session.handlerCount("Page.lifecycleEvent")).toBe(0)
		expect(session.handlerCount("Page.domContentEventFired")).toBe(0)
		expect(session.handlerCount("Page.loadEventFired")).toBe(0)
		expect(() => page.on("console", () => {})).toThrow(CDPConnectionClosedError)
	})
})

describe("NetworkManager.dispose", () => {
	test("settles pending waitForIdle waiters", async () => {
		const manager = new NetworkManager()
		const session = new FakeSession("s-net")
		manager.trackSession(session)

		// Non-finite budget → no timeout timer; only dispose() can settle this.
		const handle = manager.waitForIdle({
			timeoutMs: Number.POSITIVE_INFINITY,
			startTime: 0,
		})

		// An in-flight request keeps the waiter from going idle on its own.
		session.emit("Network.requestWillBeSent", {
			requestId: "r1",
			loaderId: "l1",
			type: "Fetch",
			request: { url: "https://example.com/data" },
		})

		manager.dispose()

		await expect(
			withTimeout(handle.promise, 1_000, "waitForIdle settle"),
		).rejects.toThrow("NetworkManager disposed")
	})

	test("untracking a session releases its requests from idle waiters", async () => {
		const manager = new NetworkManager()
		const session = new FakeSession("s-net-detach")
		manager.trackSession(session)
		const handle = manager.waitForIdle({
			startTime: 0,
			timeoutMs: 1_000,
			idleTimeMs: 1,
		})
		session.emit("Network.requestWillBeSent", {
			requestId: "r-detach",
			loaderId: "l-detach",
			type: "Fetch",
			request: { url: "https://example.com/data" },
		})

		manager.untrackSession(session.id)

		await withTimeout(handle.promise, 100, "untracked session idle")
		manager.dispose()
	})
})

describe("Execution context cleanup", () => {
	test("detaching a session clears cached contexts and pending waits", async () => {
		const session = new FakeSession("s-exec")
		const detach = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 7,
				origin: "",
				name: "",
				uniqueId: "ctx-7",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		expect(executionContexts.getMainWorld(session, "F0")).toBe(7)

		const pending = executionContexts.waitForMainWorld(session, "F1", 10_000)
		await waitFor(
			() => session.handlerCount("Runtime.executionContextCreated") === 2,
		)
		detach()

		expect(executionContexts.getMainWorld(session, "F0")).toBeNull()
		await expect(
			withTimeout(pending, 100, "execution context detach"),
		).rejects.toThrow("detached")
		expect(session.handlerCount("Runtime.executionContextCreated")).toBe(0)
	})
})

describe("Runtime object cleanup", () => {
	test("resolveAtIndex releases unselected remote objects", async () => {
		const session = new FakeSession("s-selector")
		const detach = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 11,
				origin: "",
				name: "",
				uniqueId: "ctx-11",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		let sequence = 0
		session.responses.set("Runtime.evaluate", () => ({
			result: { type: "object", objectId: `object-${++sequence}` },
		}))
		session.responses.set("DOM.requestNode", () => ({ nodeId: sequence }))
		const frame = new Frame(session, "F0", "P0", false)
		const resolver = new FrameSelectorResolver(frame)

		const selected = await resolver.resolveAtIndex(
			{ kind: "text", value: "match" },
			2,
		)

		expect(selected?.objectId).toBe("object-3")
		const released = session.sent
			.filter((entry) => entry.method === "Runtime.releaseObject")
			.map((entry) => (entry.params as { objectId: string }).objectId)
		expect(released).toEqual(["object-1", "object-2"])

		session.responses.set("Runtime.evaluate", {
			result: { type: "object", objectId: "exception-object" },
			exceptionDetails: {
				exceptionId: 1,
				text: "failed",
				lineNumber: 1,
				columnNumber: 1,
			},
		})
		expect(
			await resolver.resolveAtIndex({ kind: "text", value: "match" }, 0),
		).toBeNull()
		expect(
			session.sent.some(
				(entry) =>
					entry.method === "Runtime.releaseObject" &&
					(entry.params as { objectId: string }).objectId ===
						"exception-object",
			),
		).toBe(true)
		detach()
	})

	test("scoped accessibility snapshots release their focus object", async () => {
		const session = new FakeSession("s-a11y")
		const detach = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 12,
				origin: "",
				name: "",
				uniqueId: "ctx-12",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		session.responses.set("Accessibility.getFullAXTree", {
			nodes: [
				{
					nodeId: "ax-1",
					backendDOMNodeId: 42,
					role: { type: "role", value: "button" },
					name: { type: "computedString", value: "Submit" },
				},
			],
		})
		session.responses.set("Runtime.evaluate", {
			result: { type: "object", objectId: "focus-object" },
		})
		session.responses.set("DOM.describeNode", {
			node: { nodeId: 1, backendNodeId: 42, nodeType: 1, nodeName: "BUTTON" },
		})

		await a11yForFrame(session, "F0", {
			focusSelector: "#submit",
			tagNameMap: {},
			scrollableMap: {},
			experimental: false,
			encode: (backendNodeId) => `0-${backendNodeId}`,
		})

		expect(
			session.sent.some(
				(entry) =>
					entry.method === "Runtime.releaseObject" &&
					(entry.params as { objectId: string }).objectId === "focus-object",
			),
		).toBe(true)
		detach()
	})

	test("console object arguments are released after listeners run", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-console")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const page = await Page.create(conn, session, "t-console", null)
		let received = ""
		let receivedObjectId: string | undefined
		page.on("console", (message) => {
			received = message.text()
			receivedObjectId = message.args()[0]?.objectId
		})

		session.emit("Runtime.consoleAPICalled", {
			type: "log",
			args: [{ type: "object", objectId: "console-object", description: "{}" }],
			executionContextId: 1,
			timestamp: 1,
		})

		expect(received).toBe("{}")
		expect(receivedObjectId).toBeUndefined()
		await waitFor(() =>
			session.sent.some(
				(entry) =>
					entry.method === "Runtime.releaseObject" &&
					(entry.params as { objectId: string }).objectId === "console-object",
			),
		)
		page.disposeResources()
	})
})

describe("TargetRouter.register rollback", () => {
	class FailingAutoAttachConnection extends FakeConnection {
		public failuresRemaining = 1
		override async enableAutoAttach(): Promise<void> {
			if (this.failuresRemaining > 0) {
				this.failuresRemaining -= 1
				throw new Error("autoattach-fail")
			}
			await super.enableAutoAttach()
		}
	}

	test("failed start unregisters the delegate", async () => {
		const conn = new FailingAutoAttachConnection()
		const router = getTargetRouter(conn)

		let claimAttempts = 0
		const delegate: TargetRouterDelegate = {
			canClaimTarget: () => {
				claimAttempts += 1
				return false
			},
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}

		await expect(router.register(delegate)).rejects.toThrow("autoattach-fail")

		// The delegate must not receive events after the failed registration.
		const session = new FakeSession("s-rollback")
		conn.sessions.set(session.id, session)
		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("t-rollback")),
		)
		await sleep(20)
		expect(claimAttempts).toBe(0)

		// A later register succeeds and routing resumes.
		const unregister = await router.register(delegate)
		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("t-rollback-2")),
		)
		await sleep(20)
		expect(claimAttempts).toBeGreaterThan(0)
		unregister()
	})

	test("connection close retires the router and releases delegates", async () => {
		const conn = new FakeConnection()
		const router = getTargetRouter(conn)
		const delegate: TargetRouterDelegate = {
			canClaimTarget: () => false,
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		await router.register(delegate)

		conn.emitTransportClosed()

		const internals = router as unknown as {
			delegates: TargetRouterDelegate[]
			loggers: Map<TargetRouterDelegate, unknown>
		}
		expect(internals.delegates).toHaveLength(0)
		expect(internals.loggers.size).toBe(0)
		await expect(router.register(delegate)).rejects.toThrow("closed")
	})

	test("unregister during ownership lookup resumes the target", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-router-race")
		conn.sessions.set(session.id, session)
		const router = getTargetRouter(conn)
		let finishClaim!: (claimed: boolean) => void
		const claim = new Promise<boolean>((resolve) => {
			finishClaim = resolve
		})
		let attached = false
		const delegate: TargetRouterDelegate = {
			canClaimTarget: () => claim,
			onRouterAttachedToTarget: () => {
				attached = true
			},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		const unregister = await router.register(delegate)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("t-router-race")),
		)
		unregister()
		finishClaim(true)

		await waitFor(() =>
			conn.sent.some(
				(entry) =>
					entry.method === "Target.detachFromTarget" &&
					(entry.params as { sessionId: string }).sessionId === session.id,
			),
		)
		expect(attached).toBe(false)
	})
})

describe("LifecycleWatcher abort safety", () => {
	test("abort before wait() does not raise unhandledRejection", async () => {
		const session = new FakeSession("s-watch")
		const fakePage = {
			mainFrameId: () => "F0",
			isCurrentNavigationCommand: () => true,
		} as unknown as PageType

		let unhandled: unknown = null
		const onUnhandled = (reason: unknown) => {
			unhandled = reason
		}
		process.on("unhandledRejection", onUnhandled)

		try {
			const watcher = new LifecycleWatcher({
				page: fakePage,
				mainSession: session,
				networkManager: new NetworkManager(),
				waitUntil: "load",
				timeoutMs: 1_000,
				navigationCommandId: 1,
			})

			// Abort while nobody is racing abortPromise yet.
			session.emit("Page.frameDetached", { frameId: "F0", reason: "remove" })

			await sleep(25)
			watcher.dispose()
			await sleep(10)

			expect(unhandled).toBeNull()
			expect(session.handlerCount("Page.frameNavigated")).toBe(0)
			expect(session.handlerCount("Page.frameDetached")).toBe(0)
		} finally {
			process.off("unhandledRejection", onUnhandled)
		}
	})

	test("abort cancels the underlying page lifecycle wait", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-watch-page")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const detachExec = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 21,
				origin: "",
				name: "",
				uniqueId: "ctx-21",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		const page = await Page.create(conn, session, "t-watch-page", null)
		const watcher = new LifecycleWatcher({
			page,
			mainSession: session,
			networkManager: new NetworkManager(),
			waitUntil: "load",
			timeoutMs: 10_000,
			navigationCommandId: 1,
		})

		const waiting = watcher.wait()
		await waitFor(() => session.handlerCount("Page.loadEventFired") > 0)
		session.emit("Page.frameDetached", { frameId: "F0", reason: "remove" })

		await expect(
			withTimeout(waiting, 100, "watcher abort cleanup"),
		).rejects.toThrow("detached")
		expect(session.handlerCount("Page.lifecycleEvent")).toBe(0)
		expect(session.handlerCount("Page.domContentEventFired")).toBe(0)
		expect(session.handlerCount("Page.loadEventFired")).toBe(0)
		page.disposeResources()
		detachExec()
	})
})

describe("NavigationResponseTracker finished() after dispose", () => {
	function documentResponseEvent(requestId: string, loaderId: string) {
		return {
			requestId,
			loaderId,
			timestamp: 1,
			type: "Document",
			frameId: "F0",
			response: {
				url: "https://example.com/",
				status: 200,
				statusText: "OK",
				headers: {},
				mimeType: "text/html",
				connectionReused: false,
				connectionId: 1,
				encodedDataLength: 0,
				securityState: "secure",
			},
		}
	}

	test("loadingFinished after dispose still resolves finished()", async () => {
		const session = new FakeSession("s-nav")
		const connection = new FakeConnection()
		const fakePage = {
			mainFrameId: () => "F0",
			isCurrentNavigationCommand: () => true,
		} as unknown as PageType

		const tracker = new NavigationResponseTracker({
			page: fakePage,
			session,
			connection,
			navigationCommandId: 1,
		})
		tracker.setExpectedLoaderId("L1")

		session.emit("Network.responseReceived", documentResponseEvent("R1", "L1"))
		const response = await tracker.navigationCompleted()
		expect(response).not.toBeNull()
		if (!response) throw new Error("expected a navigation response")

		// goto() disposes the tracker before the document request finishes.
		tracker.dispose()
		tracker.dispose() // idempotent

		session.emit("Network.loadingFinished", { requestId: "R1", timestamp: 2 })

		const finished = await withTimeout(response.finished(), 2_000, "finished")
		expect(finished).toBeNull()

		// The detached listeners remove themselves once settled.
		expect(session.handlerCount("Network.loadingFinished")).toBe(0)
		expect(session.handlerCount("Network.loadingFailed")).toBe(0)
	})

	test("loadingFailed after dispose surfaces the error", async () => {
		const session = new FakeSession("s-nav-fail")
		const connection = new FakeConnection()
		const fakePage = {
			mainFrameId: () => "F0",
			isCurrentNavigationCommand: () => true,
		} as unknown as PageType

		const tracker = new NavigationResponseTracker({
			page: fakePage,
			session,
			connection,
			navigationCommandId: 1,
		})
		tracker.setExpectedLoaderId("L2")
		session.emit("Network.responseReceived", documentResponseEvent("R2", "L2"))
		const response = await tracker.navigationCompleted()
		if (!response) throw new Error("expected a navigation response")

		tracker.dispose()
		session.emit("Network.loadingFailed", {
			requestId: "R2",
			timestamp: 2,
			errorText: "net::ERR_CONNECTION_RESET",
		})

		const finished = await withTimeout(response.finished(), 2_000, "finished")
		expect(finished).toBeInstanceOf(Error)
		expect((finished as Error).message).toContain("net::ERR_CONNECTION_RESET")
		expect(session.handlerCount("Network.loadingFinished")).toBe(0)
		expect(session.handlerCount("Network.loadingFailed")).toBe(0)
	})

	test("connection close settles finished() immediately", async () => {
		const session = new FakeSession("s-nav-close")
		const connection = new FakeConnection()
		const fakePage = {
			mainFrameId: () => "F0",
			isCurrentNavigationCommand: () => true,
		} as unknown as PageType

		const tracker = new NavigationResponseTracker({
			page: fakePage,
			session,
			connection,
			navigationCommandId: 1,
		})
		tracker.setExpectedLoaderId("L3")
		session.emit("Network.responseReceived", documentResponseEvent("R3", "L3"))
		const response = await tracker.navigationCompleted()
		if (!response) throw new Error("expected a navigation response")

		tracker.dispose()
		connection.emitTransportClosed("remote closed")

		const finished = await withTimeout(response.finished(), 100, "finished")
		expect(finished).toBeInstanceOf(CDPConnectionClosedError)
		expect(session.handlerCount("Network.loadingFinished")).toBe(0)
		expect(session.handlerCount("Network.loadingFailed")).toBe(0)
	})

	test("session detach settles finished() and removes root listeners", async () => {
		const session = new FakeSession("s-nav-detach")
		const connection = new FakeConnection()
		const fakePage = {
			mainFrameId: () => "F0",
			isCurrentNavigationCommand: () => true,
		} as unknown as PageType
		const tracker = new NavigationResponseTracker({
			page: fakePage,
			session,
			connection,
			navigationCommandId: 1,
		})
		tracker.setExpectedLoaderId("L4")
		session.emit("Network.responseReceived", documentResponseEvent("R4", "L4"))
		const response = await tracker.navigationCompleted()
		if (!response) throw new Error("expected a navigation response")

		tracker.dispose()
		connection.emit("Target.detachedFromTarget", {
			sessionId: session.id,
			targetId: "t-nav-detach",
		})

		const finished = await withTimeout(response.finished(), 100, "finished")
		expect(finished).toBeInstanceOf(Error)
		expect(session.handlerCount("Network.loadingFinished")).toBe(0)
		expect(session.handlerCount("Network.loadingFailed")).toBe(0)
		expect(connection.handlerCount("Target.detachedFromTarget")).toBe(0)
	})

	test("detach before tracker disposal is not missed", async () => {
		const session = new FakeSession("s-nav-early-detach")
		const connection = new FakeConnection()
		const fakePage = {
			mainFrameId: () => "F0",
			isCurrentNavigationCommand: () => true,
		} as unknown as PageType
		const tracker = new NavigationResponseTracker({
			page: fakePage,
			session,
			connection,
			navigationCommandId: 1,
		})
		tracker.setExpectedLoaderId("L5")
		session.emit("Network.responseReceived", documentResponseEvent("R5", "L5"))
		const response = await tracker.navigationCompleted()
		if (!response) throw new Error("expected a navigation response")

		connection.emit("Target.detachedFromTarget", {
			sessionId: session.id,
			targetId: "t-nav-early-detach",
		})
		tracker.dispose()

		const finished = await withTimeout(response.finished(), 100, "finished")
		expect(finished).toBeInstanceOf(Error)
		expect(connection.handlerCount("Target.detachedFromTarget")).toBe(0)
	})
})
