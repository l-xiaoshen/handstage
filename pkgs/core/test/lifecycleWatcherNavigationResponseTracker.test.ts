/**
 * Regression tests for LifecycleWatcher and NavigationResponseTracker lifecycle behavior.
 */
import { describe, expect, test } from "bun:test"
import { withTimeout } from "../src/v3/timeoutConfig"
import { CDPConnectionClosedError } from "../src/v3/types/public/sdkErrors"
import { executionContexts } from "../src/v3/understudy/executionContextRegistry"
import { LifecycleWatcher } from "../src/v3/understudy/lifecycleWatcher"
import { NavigationResponseTracker } from "../src/v3/understudy/navigationResponseTracker"
import { NetworkManager } from "../src/v3/understudy/networkManager"
import type { Page as PageType } from "../src/v3/understudy/page"
import { Page } from "../src/v3/understudy/page"
import { FakeConnection, FakeSession, waitFor } from "./_fakes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("LifecycleWatcher abort safety", () => {
	test("goto waits for its loader before accepting document.readyState", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-navigation-loader-gate")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		session.responses.set("Page.navigate", {
			frameId: "F0",
			loaderId: "loader-new",
		})
		session.responses.set("Runtime.evaluate", {
			result: { type: "string", value: "complete" },
		})
		const detach = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 51,
				origin: "",
				name: "",
				uniqueId: "ctx-51",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		const page = await Page.create(conn, session, "t-loader-gate", null)
		const navigation = page.goto("https://example.com/new", { timeoutMs: 500 })
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.navigate"),
		)
		await sleep(10)
		expect(
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		).toBe(false)

		session.emit("Page.frameNavigated", {
			frame: {
				id: "F0",
				loaderId: "loader-new",
				url: "https://example.com/new",
			},
			type: "Navigation",
		})
		await withTimeout(navigation, 100, "loader-gated navigation")
		expect(
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		).toBe(true)
		page.disposeResources()
		detach()
	})

	test("a newer navigation rejects an older watcher", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-navigation-superseded")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		session.responses.set("Page.navigate", (params: unknown) => ({
			frameId: "F0",
			loaderId: String((params as { url: string }).url).endsWith("second")
				? "loader-second"
				: "loader-first",
		}))
		session.responses.set("Runtime.evaluate", {
			result: { type: "string", value: "complete" },
		})
		const detach = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 52,
				origin: "",
				name: "",
				uniqueId: "ctx-52",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		const page = await Page.create(conn, session, "t-superseded", null)
		const first = page.goto("https://example.com/first", { timeoutMs: 500 })
		await waitFor(
			() =>
				session.sent.filter((entry) => entry.method === "Page.navigate")
					.length === 1,
		)
		const second = page.goto("https://example.com/second", { timeoutMs: 500 })
		await waitFor(
			() =>
				session.sent.filter((entry) => entry.method === "Page.navigate")
					.length === 2,
		)
		session.emit("Page.frameNavigated", {
			frame: {
				id: "F0",
				loaderId: "loader-second",
				url: "https://example.com/second",
			},
			type: "Navigation",
		})

		await expect(first).rejects.toThrow("superseded")
		await withTimeout(second, 100, "current navigation")
		page.disposeResources()
		detach()
	})

	test("network idle ignores requests from before the navigation", async () => {
		const oldTimestamp = Date.now()
		await sleep(2)
		const watcher = new LifecycleWatcher({
			page: {
				mainFrameId: () => "F0",
				isCurrentNavigationCommand: () => true,
			} as unknown as PageType,
			mainSession: new FakeSession("s-watch-generation"),
			networkManager: new NetworkManager(),
			waitUntil: "networkidle",
			timeoutMs: 1000,
			navigationCommandId: 1,
		})
		const filter = (
			watcher as unknown as {
				buildIdleFilter: () => (info: {
					timestamp: number
					resourceType?: string
				}) => boolean
			}
		).buildIdleFilter()

		expect(filter({ timestamp: oldTimestamp, resourceType: "Fetch" })).toBe(
			false,
		)
		expect(filter({ timestamp: Date.now(), resourceType: "Fetch" })).toBe(true)
		watcher.dispose()
	})

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
		;(
			page as unknown as { latestNavigationCommandId: number }
		).latestNavigationCommandId = 1
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
		if (!response) {
			throw new Error("expected a navigation response")
		}

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
		if (!response) {
			throw new Error("expected a navigation response")
		}

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
		if (!response) {
			throw new Error("expected a navigation response")
		}

		tracker.dispose()
		connection.emitTransportClosed("remote closed")

		const finished = await withTimeout(response.finished(), 100, "finished")
		expect(finished).toBeInstanceOf(CDPConnectionClosedError)
		expect(session.handlerCount("Network.loadingFinished")).toBe(0)
		expect(session.handlerCount("Network.loadingFailed")).toBe(0)
	})

	test("Page disposal settles Response.finished and removes listeners", async () => {
		const session = new FakeSession("s-nav-page-dispose")
		const connection = new FakeConnection()
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const page = await Page.create(
			connection,
			session,
			"t-nav-page-dispose",
			null,
		)
		const tracker = new NavigationResponseTracker({
			page,
			session,
			connection,
			navigationCommandId: 0,
		})
		tracker.setExpectedLoaderId("L-page-dispose")
		session.emit(
			"Network.responseReceived",
			documentResponseEvent("R-page-dispose", "L-page-dispose"),
		)
		const response = await tracker.navigationCompleted()
		if (!response) {
			throw new Error("expected a navigation response")
		}
		tracker.dispose()

		page.disposeResources()

		const finished = await withTimeout(
			response.finished(),
			100,
			"page-disposed response",
		)
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
		if (!response) {
			throw new Error("expected a navigation response")
		}

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
		if (!response) {
			throw new Error("expected a navigation response")
		}

		connection.emit("Target.detachedFromTarget", {
			sessionId: session.id,
			targetId: "t-nav-early-detach",
		})
		tracker.dispose()

		const finished = await withTimeout(response.finished(), 100, "finished")
		expect(finished).toBeInstanceOf(Error)
		expect(connection.handlerCount("Target.detachedFromTarget")).toBe(0)
	})

	test("finish before loader selection settles the eventual response", async () => {
		const session = new FakeSession("s-nav-early-finish")
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

		session.emit(
			"Network.responseReceived",
			documentResponseEvent("R-early", "L-early"),
		)
		session.emit("Network.loadingFinished", {
			requestId: "R-early",
			timestamp: 2,
		})
		tracker.setExpectedLoaderId("L-early")

		const response = await tracker.navigationCompleted()
		if (!response) {
			throw new Error("expected a navigation response")
		}
		expect(
			await withTimeout(response.finished(), 100, "early finish"),
		).toBeNull()
		tracker.dispose()
	})

	test("unrelated pre-response metadata remains bounded", () => {
		const session = new FakeSession("s-nav-bounded")
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

		for (let index = 0; index < 1_000; index += 1) {
			session.emit("Network.responseReceivedExtraInfo", {
				requestId: `unrelated-${index}`,
				blockedCookies: [],
				headers: {},
				resourceIPAddressSpace: "Unknown",
				statusCode: 200,
			})
		}
		const internals = tracker as unknown as {
			pendingExtraInfo: Map<string, unknown>
			pendingTerminalEvents: Map<string, unknown>
		}
		expect(internals.pendingExtraInfo.size).toBeLessThanOrEqual(256)
		expect(internals.pendingTerminalEvents.size).toBe(0)
		tracker.dispose()
	})
})
