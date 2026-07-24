/**
 * Regression tests for Page, frame, and screenshot resource lifecycle behavior.
 */
import { describe, expect, test } from "bun:test"
import type { Protocol } from "devtools-protocol"
import { withTimeout } from "../src/v3/timeoutConfig"
import { CDPConnectionClosedError } from "../src/v3/types/public/sdkErrors"
import type {
	CDPCommand,
	CDPCommandParams,
	CDPCommandResult,
} from "../src/v3/understudy/cdp"
import { executionContexts } from "../src/v3/understudy/executionContextRegistry"
import { Frame } from "../src/v3/understudy/frame"
import { FrameRegistry } from "../src/v3/understudy/frameRegistry"
import { Page } from "../src/v3/understudy/page"
import { FakeConnection, FakeSession, pageTarget, waitFor } from "./_fakes"

describe("frame cache pruning", () => {
	test("Page.close remains usable and retryable after browser refusal", async () => {
		class RefusingCloseConnection extends FakeConnection {
			public closeTargetCalls = 0
			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method === "Target.closeTarget") {
					this.closeTargetCalls += 1
					if (this.closeTargetCalls > 1) {
						this.targets = []
					}
					return Promise.resolve({
						success: this.closeTargetCalls > 1,
					} as CDPCommandResult<M>)
				}
				return super.send(method, ...params)
			}
		}

		const conn = new RefusingCloseConnection()
		conn.targets = [pageTarget("t-page-close-retry")]
		const session = new FakeSession("s-page-close-retry")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const page = await Page.create(conn, session, "t-page-close-retry", null)

		await expect(page.close()).rejects.toThrow("refused")
		expect(page.isDisposed()).toBe(false)
		await expect(page.sendCDP("Page.enable")).resolves.toBeDefined()

		await page.close()
		expect(page.isDisposed()).toBe(true)
		expect(conn.closeTargetCalls).toBe(2)
	})

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

	test("root swaps preserve the incoming frame metadata", () => {
		const registry = new FrameRegistry("tgt", "F0")
		registry.onFrameNavigated(
			{
				id: "F1",
				loaderId: "loader-new",
				url: "https://example.com/new",
				domainAndRegistry: "example.com",
				securityOrigin: "https://example.com",
				mimeType: "text/html",
				adFrameStatus: { adFrameType: "none" },
				secureContextType: "Secure",
				crossOriginIsolatedContextType: "NotIsolated",
				gatedAPIFeatures: [],
			} as Protocol.Page.Frame,
			"s-root",
		)

		const tree = registry.asProtocolFrameTree("F1")
		expect(registry.mainFrameId()).toBe("F1")
		expect(tree.frame.id).toBe("F1")
		expect(tree.frame.loaderId).toBe("loader-new")
		expect(tree.frame.url).toBe("https://example.com/new")
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

	test("Page disposal cancels long delays and navigation commands", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-page-operations")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const page = await Page.create(conn, session, "t-page-operations", null)
		session.responses.set("Page.navigate", new Promise<never>(() => {}))

		const delay = page.waitForTimeout(60_000)
		const navigation = page.goto("https://example.com")
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.navigate"),
		)
		const observedDelay = delay.then(
			() => null,
			(error) => error as Error,
		)
		const observedNavigation = navigation.then(
			() => null,
			(error) => error as Error,
		)
		page.disposeResources()

		const delayError = await withTimeout(
			observedDelay,
			100,
			"page delay disposal",
		)
		const navigationError = await withTimeout(
			observedNavigation,
			100,
			"page navigation disposal",
		)
		expect(delayError?.message).toContain("disposed")
		expect(navigationError?.message).toContain("disposed")
		expect(session.handlerCount("Network.responseReceived")).toBe(0)
		expect(session.handlerCount("Page.frameNavigated")).toBe(0)
	})

	test("navigation timeout covers a blackholed Page.navigate command", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-navigation-timeout")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		session.responses.set("Page.navigate", new Promise<never>(() => {}))
		const page = await Page.create(conn, session, "t-navigation-timeout", null)

		await expect(
			withTimeout(
				page.goto("https://example.com", { timeoutMs: 10 }),
				100,
				"outer navigation guard",
			),
		).rejects.toThrow("goto timed out after 10ms")
		expect(session.handlerCount("Page.frameNavigated")).toBe(0)
		page.disposeResources()
	})

	test("lifecycle deadlines cover setup commands", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-lifecycle-setup-timeout")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const page = await Page.create(
			conn,
			session,
			"t-lifecycle-setup-timeout",
			null,
		)
		session.responses.set(
			"Page.setLifecycleEventsEnabled",
			new Promise<never>(() => {}),
		)

		await expect(
			withTimeout(
				page.waitForMainLoadState("load", 10),
				100,
				"outer page lifecycle guard",
			),
		).rejects.toThrow("waitForMainLoadState(load) timed out after 10ms")

		const frameSession = new FakeSession("s-frame-lifecycle-timeout")
		frameSession.responses.set("Page.enable", new Promise<never>(() => {}))
		const frame = new Frame(frameSession, "F0", "P0", false)
		await expect(
			withTimeout(
				frame.waitForLoadState("load", 10),
				100,
				"outer frame lifecycle guard",
			),
		).rejects.toThrow("waitForLoadState(load) timed out after 10ms")
		page.disposeResources()
	})

	test("screenshot timeout covers scale computation", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-screenshot-scale")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const detach = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 31,
				origin: "",
				name: "",
				uniqueId: "ctx-31",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		const page = await Page.create(conn, session, "t-screenshot-scale", null)
		session.responses.set("Runtime.evaluate", new Promise<never>(() => {}))

		await expect(
			withTimeout(
				page.screenshot({ scale: "css", timeout: 10 }),
				100,
				"outer guard",
			),
		).rejects.toThrow("screenshot timed out after 10ms")

		page.disposeResources()
		detach()
	})

	test("screenshot rollback is bounded when cleanup commands blackhole", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-screenshot-cleanup")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const detach = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 32,
				origin: "",
				name: "",
				uniqueId: "ctx-32",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		let evaluationCount = 0
		session.responses.set("Runtime.evaluate", () => {
			evaluationCount += 1
			if (evaluationCount === 1) {
				return { result: { type: "undefined" } }
			}
			return new Promise<never>(() => {})
		})
		session.responses.set(
			"Page.captureScreenshot",
			new Promise<never>(() => {}),
		)
		const page = await Page.create(conn, session, "t-screenshot-cleanup", null)

		await expect(
			withTimeout(
				page.screenshot({ timeout: 10 }),
				200,
				"outer screenshot cleanup guard",
			),
		).rejects.toThrow("screenshot timed out after 10ms")
		expect(evaluationCount).toBe(2)

		page.disposeResources()
		detach()
	})
})
