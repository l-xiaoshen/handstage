/**
 * Regression tests for memory-leak / resource-lifecycle fixes.
 *
 * Each describe block pins one class of leak:
 * - CDPConnection.close() must settle in-flight commands & dispatch waiters.
 * - ExternalConnectionAdapter.off() must detach its per-event root listener.
 * - Handstage must drop closed contexts from its registry.
 * - Page/FrameRegistry must prune frame caches for entire detached subtrees.
 * - NetworkManager.dispose() must settle pending waitForIdle waiters.
 * - TargetRouter.register() must roll back the delegate when start() fails.
 * - LifecycleWatcher aborts must never surface as unhandledRejection.
 * - response.finished() must still settle after the navigation tracker is
 *   disposed (and its detached listeners must clean themselves up).
 */
import { describe, expect, test } from "bun:test"
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
	test("in-flight commands reject instead of hanging forever", async () => {
		// InMemoryTransport never replies to Page.enable, so without the fix
		// this promise (and its Inflight record) would stay pending forever.
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

		adapter.on("Network.loadingFinished", handler)
		expect(external.handlerCount("Network.loadingFinished")).toBe(1)

		adapter.off("Network.loadingFinished", handler)
		expect(external.handlerCount("Network.loadingFinished")).toBe(0)

		// Re-subscribing after a full teardown must re-install the root listener.
		adapter.on("Network.loadingFinished", handler)
		expect(external.handlerCount("Network.loadingFinished")).toBe(1)

		await adapter.close()
		expect(external.handlerCount("Network.loadingFinished")).toBe(0)
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

		// Populate the caches the way real callers do.
		page.frameForId("F1")
		page.frameForId("F2")
		page.getOrdinal("F0")
		page.getOrdinal("F1")
		page.getOrdinal("F2")

		// Only F1 emits frameDetached; F2 is removed implicitly as descendant.
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

		// No timeout timer (non-finite budget): without the fix this waiter
		// could never settle after dispose() silently drops its observer.
		const handle = manager.waitForIdle({
			timeoutMs: Number.POSITIVE_INFINITY,
			startTime: 0,
		})

		// Keep the waiter busy so it is not idle when dispose runs.
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

		// The delegate must not linger inside the router after the failure.
		const session = new FakeSession("s-rollback")
		conn.sessions.set(session.id, session)
		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("t-rollback")),
		)
		await sleep(20)
		expect(claimAttempts).toBe(0)

		// A later register must succeed and start routing again.
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

			// Triggers the abort path while nobody is racing abortPromise yet.
			session.emit("Page.frameDetached", { frameId: "F0", reason: "remove" })

			// Give a potential unhandled rejection a macrotask to surface.
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
		const fakePage = {
			mainFrameId: () => "F0",
			isCurrentNavigationCommand: () => true,
		} as unknown as PageType

		const tracker = new NavigationResponseTracker({
			page: fakePage,
			session,
			navigationCommandId: 1,
		})
		tracker.setExpectedLoaderId("L1")

		session.emit("Network.responseReceived", documentResponseEvent("R1", "L1"))
		const response = await tracker.navigationCompleted()
		expect(response).not.toBeNull()
		if (!response) throw new Error("expected a navigation response")

		// Page.goto disposes the tracker right after navigation completes —
		// often before the document request has finished loading.
		tracker.dispose()
		tracker.dispose() // idempotent: must not double-install listeners

		session.emit("Network.loadingFinished", { requestId: "R1", timestamp: 2 })

		const finished = await withTimeout(response.finished(), 2_000, "finished")
		expect(finished).toBeNull()

		// The detached listeners must remove themselves once settled.
		expect(session.handlerCount("Network.loadingFinished")).toBe(0)
		expect(session.handlerCount("Network.loadingFailed")).toBe(0)
	})

	test("loadingFailed after dispose surfaces the error", async () => {
		const session = new FakeSession("s-nav-fail")
		const fakePage = {
			mainFrameId: () => "F0",
			isCurrentNavigationCommand: () => true,
		} as unknown as PageType

		const tracker = new NavigationResponseTracker({
			page: fakePage,
			session,
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
})
