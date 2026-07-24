/**
 * Regression tests for network, execution context, and runtime object lifecycle behavior.
 */
import { describe, expect, test } from "bun:test"
import { withTimeout } from "../src/v3/timeoutConfig"
import { HandstageEvalError } from "../src/v3/types/public/sdkErrors"
import { a11yForFrame } from "../src/v3/understudy/a11y/snapshot/a11yTree"
import { executionContexts } from "../src/v3/understudy/executionContextRegistry"
import { Frame } from "../src/v3/understudy/frame"
import { NetworkManager } from "../src/v3/understudy/networkManager"
import { Page } from "../src/v3/understudy/page"
import { releaseObjectIds } from "../src/v3/understudy/runtimeObjectUtils"
import { FrameSelectorResolver } from "../src/v3/understudy/selectorResolver"
import { FakeConnection, FakeSession, waitFor } from "./_fakes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

	test("waitForIdle includes requests already in flight", async () => {
		const manager = new NetworkManager()
		const session = new FakeSession("s-net-existing")
		manager.trackSession(session)
		session.emit("Network.requestWillBeSent", {
			requestId: "r-existing",
			loaderId: "l-existing",
			type: "Fetch",
			request: { url: "https://example.com/slow" },
		})

		const handle = manager.waitForIdle({
			startTime: Date.now(),
			timeoutMs: 1_000,
			idleTimeMs: 1,
		})
		let settled = false
		void handle.promise.then(() => {
			settled = true
		})
		await sleep(10)
		expect(settled).toBe(false)

		session.emit("Network.loadingFinished", { requestId: "r-existing" })
		await withTimeout(handle.promise, 100, "existing request idle")
		manager.dispose()
	})

	test("subresources cannot erase the current document fallback", () => {
		const manager = new NetworkManager()
		const session = new FakeSession("s-net-document")
		manager.trackSession(session)
		session.emit("Network.requestWillBeSent", {
			requestId: "document-1",
			frameId: "F0",
			loaderId: "loader-1",
			type: "Document",
			request: { url: "https://example.com" },
		})
		session.emit("Network.requestWillBeSent", {
			requestId: "style-1",
			frameId: "F0",
			loaderId: "loader-1",
			type: "Stylesheet",
			request: { url: "https://example.com/style.css" },
		})
		session.emit("Network.loadingFinished", { requestId: "style-1" })

		const internals = manager as unknown as {
			documentRequestsByFrame: Map<string, string>
		}
		expect(internals.documentRequestsByFrame.get("F0")).toBe(
			"s-net-document:document-1",
		)

		session.emit("Network.requestWillBeSent", {
			requestId: "document-2",
			frameId: "F0",
			loaderId: "loader-2",
			type: "Document",
			request: { url: "https://example.com/next" },
		})
		session.emit("Network.loadingFinished", { requestId: "document-1" })
		expect(internals.documentRequestsByFrame.get("F0")).toBe(
			"s-net-document:document-2",
		)
		manager.dispose()
	})

	test("callbacks captured from an untracked session cannot restore requests", () => {
		const manager = new NetworkManager()
		const oldSession = new FakeSession("s-net-reused")
		manager.trackSession(oldSession)
		const lateRequestHandlers = oldSession.handlersFor(
			"Network.requestWillBeSent",
		)
		const lateStoppedHandlers = oldSession.handlersFor(
			"Page.frameStoppedLoading",
		)
		manager.untrackSession(oldSession.id)

		const currentSession = new FakeSession("s-net-reused")
		manager.trackSession(currentSession)
		currentSession.emit("Network.requestWillBeSent", {
			requestId: "current-document",
			frameId: "F0",
			loaderId: "current-loader",
			type: "Document",
			request: { url: "https://example.com/current" },
		})
		for (const handler of lateRequestHandlers) {
			handler({
				requestId: "late-request",
				frameId: "F0",
				loaderId: "old-loader",
				type: "Fetch",
				request: { url: "https://example.com/late" },
			})
		}
		for (const handler of lateStoppedHandlers) {
			handler({ frameId: "F0" })
		}

		const internals = manager as unknown as {
			requests: Map<string, unknown>
			documentRequestsByFrame: Map<string, string>
		}
		expect(internals.requests.has("s-net-reused:late-request")).toBe(false)
		expect(internals.requests.has("s-net-reused:current-document")).toBe(true)
		expect(internals.documentRequestsByFrame.get("F0")).toBe(
			"s-net-reused:current-document",
		)
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
		const queuedCreatedHandlers = session.handlersFor(
			"Runtime.executionContextCreated",
		)
		detach()
		for (const handler of queuedCreatedHandlers) {
			handler({
				context: {
					id: 99,
					origin: "",
					name: "",
					uniqueId: "ctx-late",
					auxData: { frameId: "F1", isDefault: true },
				},
			})
		}

		expect(executionContexts.getMainWorld(session, "F0")).toBeNull()
		expect(executionContexts.getMainWorld(session, "F1")).toBeNull()
		await expect(
			withTimeout(pending, 100, "execution context detach"),
		).rejects.toThrow("detached")
		expect(session.handlerCount("Runtime.executionContextCreated")).toBe(0)
	})
})

describe("Runtime object cleanup", () => {
	test("releaseObjectIds waits for dispatched cleanup to settle", async () => {
		const session = new FakeSession("s-release-ordering")
		let finishRelease!: () => void
		session.responses.set(
			"Runtime.releaseObject",
			new Promise<void>((resolve) => {
				finishRelease = resolve
			}),
		)
		let settled = false
		const cleanup = releaseObjectIds(session, ["object-1"]).then(() => {
			settled = true
		})
		await sleep(5)
		expect(settled).toBe(false)

		finishRelease()
		await cleanup
		expect(settled).toBe(true)
	})

	test("aborted selector resolution releases its object group", async () => {
		const session = new FakeSession("s-selector-abort")
		const detach = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 13,
				origin: "",
				name: "",
				uniqueId: "ctx-13",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		session.responses.set("Runtime.evaluate", new Promise<never>(() => {}))
		const resolver = new FrameSelectorResolver(
			new Frame(session, "F0", "P0", false),
		)
		const controller = new AbortController()
		const resolving = resolver.resolveAtIndex(
			{ kind: "text", value: "match" },
			0,
			controller.signal,
		)
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		)
		controller.abort(new Error("selector cancelled"))

		await expect(resolving).rejects.toThrow("selector cancelled")
		await waitFor(() =>
			session.sent.some(
				(entry) => entry.method === "Runtime.releaseObjectGroup",
			),
		)
		detach()
	})

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
				exception: {
					type: "object",
					objectId: "exception-details-object",
				},
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
		expect(
			session.sent.some(
				(entry) =>
					entry.method === "Runtime.releaseObject" &&
					(entry.params as { objectId: string }).objectId ===
						"exception-details-object",
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
			expect(
				session.sent.some((entry) => entry.method === "Runtime.releaseObject"),
			).toBe(false)
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

	test("console objects are released even with no public listeners", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-console-drain")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const page = await Page.create(conn, session, "t-console-drain", null)

		session.emit("Runtime.consoleAPICalled", {
			type: "log",
			args: [{ type: "object", objectId: "unobserved-console-object" }],
			executionContextId: 1,
			timestamp: 1,
		})

		await waitFor(() =>
			session.sent.some(
				(entry) =>
					entry.method === "Runtime.releaseObject" &&
					(entry.params as { objectId: string }).objectId ===
						"unobserved-console-object",
			),
		)
		page.disposeResources()
	})

	test("evaluation exceptions release result and exception objects", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-evaluate-exception")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		const detach = executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 21,
				origin: "",
				name: "",
				uniqueId: "ctx-21",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		const page = await Page.create(conn, session, "t-evaluate-exception", null)
		session.responses.set("Runtime.evaluate", {
			result: { type: "object", objectId: "evaluation-result-object" },
			exceptionDetails: {
				exceptionId: 1,
				text: "boom",
				lineNumber: 1,
				columnNumber: 1,
				exception: {
					type: "object",
					objectId: "evaluation-exception-object",
				},
			},
		})

		await expect(
			page.evaluate("throw new Error('boom')"),
		).rejects.toBeInstanceOf(HandstageEvalError)
		const released = session.sent
			.filter((entry) => entry.method === "Runtime.releaseObject")
			.map((entry) => (entry.params as { objectId: string }).objectId)
		expect(released).toContain("evaluation-result-object")
		expect(released).toContain("evaluation-exception-object")

		page.disposeResources()
		detach()
	})
})
