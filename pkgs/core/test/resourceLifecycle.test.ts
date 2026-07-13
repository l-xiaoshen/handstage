/**
 * Regression tests for resource-lifecycle fixes: close/dispose paths must
 * settle pending promises, remove listeners, and prune frame-keyed caches.
 */
import { describe, expect, test } from "bun:test"
import { connectConnection } from "../src/v3/connect/connection"
import { connectTransport } from "../src/v3/connect/transport"
import { withTimeout } from "../src/v3/timeoutConfig"
import { CDPConnectionClosedError } from "../src/v3/types/public/sdkErrors"
import {
	type CDPCommand,
	type CDPCommandParams,
	type CDPCommandResult,
	CDPConnection,
	type CDPEvent,
	type CDPEventParams,
	type ExternalCDPSession,
	ExternalConnectionAdapter,
} from "../src/v3/understudy/cdp"
import { FrameRegistry } from "../src/v3/understudy/frameRegistry"
import { LifecycleWatcher } from "../src/v3/understudy/lifecycleWatcher"
import { NavigationResponseTracker } from "../src/v3/understudy/navigationResponseTracker"
import { NetworkManager } from "../src/v3/understudy/networkManager"
import type { Page as PageType } from "../src/v3/understudy/page"
import { Page } from "../src/v3/understudy/page"
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
	})
})

describe("ExternalConnectionAdapter root listener lifecycle", () => {
	class FakeExternalSession implements ExternalCDPSession {
		public readonly id: string | null = null
		public onclose?: (reason: string) => void
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
	}

	test("off() removes the fan-out listener from the external session", async () => {
		const external = new FakeExternalSession()
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

		await adapter.close()
		expect(external.handlerCount("Network.loadingFinished")).toBe(0)
		expect(closeNotifications).toBe(1)
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
})
