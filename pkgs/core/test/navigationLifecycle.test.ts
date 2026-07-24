import { describe, expect, test } from "bun:test"
import type {
	CDPCommand,
	CDPCommandParams,
	CDPCommandResult,
} from "../src/v3/understudy/cdp"
import { Context } from "../src/v3/understudy/context"
import { executionContexts } from "../src/v3/understudy/executionContextRegistry"
import { FrameRegistry } from "../src/v3/understudy/frameRegistry"
import { Page } from "../src/v3/understudy/page"
import { FakeConnection, FakeSession, pageTarget, waitFor } from "./_fakes"

async function createPage(loaderId = "loader-old") {
	const connection = new FakeConnection()
	const session = new FakeSession(`session-${loaderId}`)
	session.responses.set("Page.getFrameTree", {
		frameTree: {
			frame: { id: "F0", loaderId, url: "about:blank" },
		},
	})
	const detach = executionContexts.attachSession(session)
	session.emit("Runtime.executionContextCreated", {
		context: {
			id: 71,
			origin: "",
			name: "",
			uniqueId: `context-${loaderId}`,
			auxData: { frameId: "F0", isDefault: true },
		},
	})
	const page = await Page.create(
		connection,
		session,
		`target-${loaderId}`,
		null,
	)
	session.responses.set("Runtime.evaluate", {
		result: { type: "string", value: "complete" },
	})
	return { connection, session, page, detach }
}

function emitNavigation(
	session: FakeSession,
	loaderId: string,
	url: string,
): void {
	session.emit("Page.frameNavigated", {
		frame: { id: "F0", loaderId, url },
		type: "Navigation",
	})
}

function emitDocumentResponse(
	session: FakeSession,
	loaderId: string,
	url: string,
): void {
	session.emit("Network.responseReceived", {
		requestId: `request-${loaderId}`,
		loaderId,
		timestamp: 1,
		type: "Document",
		frameId: "F0",
		response: {
			url,
			status: 200,
			statusText: "OK",
			headers: {},
			mimeType: "text/html",
			charset: "utf-8",
			connectionReused: false,
			connectionId: 1,
			encodedDataLength: 0,
			securityState: "secure",
		},
	})
}

describe("navigation command ordering", () => {
	test("newPage initial navigation cannot contaminate a following goto", async () => {
		class NewPageConnection extends FakeConnection {
			readonly pageSession = new FakeSession("session-new-page-navigation")

			constructor() {
				super()
				this.pageSession.responses.set("Page.getFrameTree", {
					frameTree: { frame: { id: "F0", url: "about:blank" } },
				})
			}

			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method !== "Target.createTarget") {
					return super.send(method, ...params)
				}
				this.sent.push({ method, params: params[0] })
				this.sessions.set(this.pageSession.id, this.pageSession)
				queueMicrotask(() =>
					this.emit("Target.attachedToTarget", {
						sessionId: this.pageSession.id,
						targetInfo: pageTarget("target-new-page-navigation"),
						waitingForDebugger: true,
					}),
				)
				return Promise.resolve({
					targetId: "target-new-page-navigation",
				} as CDPCommandResult<M>)
			}
		}

		const connection = new NewPageConnection()
		let resolveInitialNavigate!: (value: unknown) => void
		let navigateCalls = 0
		connection.pageSession.responses.set("Page.navigate", () => {
			navigateCalls += 1
			if (navigateCalls === 1) {
				return new Promise((resolve) => {
					resolveInitialNavigate = resolve
				})
			}
			return { frameId: "F0", loaderId: "loader-second" }
		})
		connection.pageSession.responses.set("Runtime.evaluate", {
			result: { type: "string", value: "complete" },
		})
		const context = await Context.createDefaultFromConnection(connection)
		const page = await context.newPage("https://example.com/first")
		await waitFor(
			() =>
				connection.pageSession.sent.filter(
					(entry) => entry.method === "Page.navigate",
				).length === 1,
		)
		connection.pageSession.emit("Runtime.executionContextCreated", {
			context: {
				id: 73,
				origin: "",
				name: "",
				uniqueId: "context-new-page-navigation",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		const second = page.goto("https://example.com/second", { timeoutMs: 500 })
		await waitFor(() => navigateCalls === 2)
		emitDocumentResponse(
			connection.pageSession,
			"loader-first",
			"https://example.com/first",
		)
		emitNavigation(
			connection.pageSession,
			"loader-first",
			"https://example.com/first",
		)
		resolveInitialNavigate({ frameId: "F0", loaderId: "loader-first" })
		await waitFor(() => page.isSupersededNavigationLoader("loader-first"))
		emitDocumentResponse(
			connection.pageSession,
			"loader-second",
			"https://example.com/second",
		)
		emitNavigation(
			connection.pageSession,
			"loader-second",
			"https://example.com/second",
		)
		const response = await second
		expect(response?.url()).toBe("https://example.com/second")
		await context.close()
	})

	test("a completed initial command cannot redirect a following goto", async () => {
		const { session, page, detach } = await createPage()
		let navigateCalls = 0
		session.responses.set("Page.navigate", () => {
			navigateCalls += 1
			return {
				frameId: "F0",
				loaderId: navigateCalls === 1 ? "loader-initial" : "loader-current",
			}
		})
		page.startInitialNavigation("https://example.com/initial")
		await waitFor(
			() =>
				(page as unknown as { initialNavigationLoaderId: string | null })
					.initialNavigationLoaderId === "loader-initial",
		)

		const navigating = page.goto("https://example.com/current", {
			timeoutMs: 500,
		})
		await waitFor(() => navigateCalls === 2)
		emitDocumentResponse(
			session,
			"loader-initial",
			"https://example.com/initial",
		)
		emitNavigation(session, "loader-initial", "https://example.com/initial")
		emitDocumentResponse(
			session,
			"loader-current",
			"https://example.com/current",
		)
		emitNavigation(session, "loader-current", "https://example.com/current")

		const response = await navigating
		expect(response?.url()).toBe("https://example.com/current")
		page.disposeResources()
		detach()
	})

	test("late page probes release their object group after disposal", async () => {
		const { session, page, detach } = await createPage()
		let resolveProbe!: (value: unknown) => void
		session.responses.set(
			"Runtime.evaluate",
			new Promise((resolve) => {
				resolveProbe = resolve
			}),
		)
		const title = page.title()
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		)
		const evaluateRequest = session.sent.find(
			(entry) => entry.method === "Runtime.evaluate",
		)?.params as { objectGroup?: string }
		if (!evaluateRequest.objectGroup) {
			throw new Error("expected page probe group")
		}
		page.disposeResources()
		await expect(title).rejects.toThrow("disposed")
		const releaseCount = () =>
			session.sent.filter(
				(entry) =>
					entry.method === "Runtime.releaseObjectGroup" &&
					(entry.params as { objectGroup?: string }).objectGroup ===
						evaluateRequest.objectGroup,
			).length
		await waitFor(() => releaseCount() >= 1)
		const beforeLateResult = releaseCount()
		resolveProbe({
			result: { type: "object", objectId: "late-title-result" },
			exceptionDetails: {
				exceptionId: 1,
				text: "late title failure",
				lineNumber: 0,
				columnNumber: 0,
				exception: { type: "object", objectId: "late-title-exception" },
			},
		})
		await waitFor(() => releaseCount() > beforeLateResult)
		detach()
	})

	test("Page.navigate errorText rejects without seeding the requested URL", async () => {
		const { session, page, detach } = await createPage()
		session.responses.set("Page.navigate", {
			frameId: "F0",
			errorText: "net::ERR_NAME_NOT_RESOLVED",
		})

		await expect(page.goto("https://does-not-resolve.invalid")).rejects.toThrow(
			"ERR_NAME_NOT_RESOLVED",
		)
		expect(page.url()).toBe("about:blank")
		page.disposeResources()
		detach()
	})

	test("delayed history cannot supersede a newer navigation", async () => {
		const { session, page, detach } = await createPage()
		let resolveHistory!: (value: unknown) => void
		session.responses.set(
			"Page.getNavigationHistory",
			new Promise((resolve) => {
				resolveHistory = resolve
			}),
		)
		const older = page.goBack({ timeoutMs: 0 })
		await waitFor(() =>
			session.sent.some(
				(entry) => entry.method === "Page.getNavigationHistory",
			),
		)
		session.responses.set("Page.navigate", { frameId: "F0" })
		await page.goto("https://example.com/newer", { timeoutMs: 0 })
		await expect(older).rejects.toThrow("superseded")
		resolveHistory({
			currentIndex: 1,
			entries: [
				{
					id: 1,
					url: "https://example.com/older",
					userTypedURL: "",
					title: "",
				},
				{
					id: 2,
					url: "https://example.com/newer",
					userTypedURL: "",
					title: "",
				},
			],
		})
		page.disposeResources()
		detach()
	})

	test("unavailable history does not supersede an active navigation", async () => {
		const { session, page, detach } = await createPage()
		session.responses.set("Page.navigate", {
			frameId: "F0",
			loaderId: "loader-active",
		})
		session.responses.set("Page.getNavigationHistory", {
			currentIndex: 0,
			entries: [
				{
					id: 1,
					url: "about:blank",
					userTypedURL: "about:blank",
					title: "",
				},
			],
		})

		let settled = false
		const navigation = page
			.goto("https://example.com/active", { timeoutMs: 500 })
			.finally(() => {
				settled = true
			})
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.navigate"),
		)

		expect(await page.goBack({ timeoutMs: 500 })).toBeNull()
		expect(settled).toBe(false)

		emitDocumentResponse(session, "loader-active", "https://example.com/active")
		emitNavigation(session, "loader-active", "https://example.com/active")
		await navigation
		page.disposeResources()
		detach()
	})

	test("reload ignores a queued event for the old loader", async () => {
		const { session, page, detach } = await createPage("loader-old")
		session.responses.set("Page.reload", {})
		const reloading = page.reload({ waitUntil: "load", timeoutMs: 500 })
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.reload"),
		)
		emitNavigation(session, "loader-old", "about:blank")
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		).toBe(false)

		emitNavigation(session, "loader-new", "https://example.com/reloaded")
		await reloading
		expect(
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		).toBe(true)
		page.disposeResources()
		detach()
	})

	test("a redirect observed before Page.navigate response remains authoritative", async () => {
		const { session, page, detach } = await createPage()
		let resolveNavigate!: (value: unknown) => void
		session.responses.set(
			"Page.navigate",
			new Promise((resolve) => {
				resolveNavigate = resolve
			}),
		)
		const navigating = page.goto("https://example.com/start", {
			timeoutMs: 500,
		})
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.navigate"),
		)
		emitNavigation(session, "loader-final", "https://example.com/final")
		page.onFrameNavigated(
			{
				id: "F0",
				loaderId: "loader-final",
				url: "https://example.com/final",
			} as never,
			session,
		)
		emitDocumentResponse(session, "loader-final", "https://example.com/final")
		resolveNavigate({ frameId: "F0", loaderId: "loader-initial" })
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		)

		const response = await navigating
		expect(response?.url()).toBe("https://example.com/final")
		expect(page.url()).toBe("https://example.com/final")
		page.disposeResources()
		detach()
	})

	test("a redirect observed after Page.navigate updates response tracking", async () => {
		const { session, page, detach } = await createPage()
		session.responses.set("Page.navigate", {
			frameId: "F0",
			loaderId: "loader-initial",
		})
		const navigating = page.goto("https://example.com/start", {
			timeoutMs: 500,
		})
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.navigate"),
		)
		emitDocumentResponse(session, "loader-final", "https://example.com/final")
		page.onFrameNavigated(
			{
				id: "F0",
				loaderId: "loader-final",
				url: "https://example.com/final",
			} as never,
			session,
		)
		emitNavigation(session, "loader-final", "https://example.com/final")
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		)

		const response = await navigating
		expect(response?.url()).toBe("https://example.com/final")
		expect(page.url()).toBe("https://example.com/final")
		page.disposeResources()
		detach()
	})

	test("timeout zero disables the navigation timer", async () => {
		const { session, page, detach } = await createPage()
		session.responses.set("Page.navigate", {
			frameId: "F0",
			loaderId: "loader-no-timeout",
		})
		let settled = false
		const navigation = page
			.goto("https://example.com/no-timeout", { timeoutMs: 0 })
			.finally(() => {
				settled = true
			})
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(settled).toBe(false)
		emitNavigation(
			session,
			"loader-no-timeout",
			"https://example.com/no-timeout",
		)
		await navigation
		page.disposeResources()
		detach()
	})

	test("same-document navigation actively aborts an older loader wait", async () => {
		const { session, page, detach } = await createPage()
		session.responses.set("Page.navigate", (params: unknown) => {
			const url = (params as { url: string }).url
			return url.endsWith("same-document")
				? { frameId: "F0" }
				: { frameId: "F0", loaderId: "loader-first" }
		})
		const first = page.goto("https://example.com/first", { timeoutMs: 500 })
		await waitFor(
			() =>
				session.sent.filter((entry) => entry.method === "Page.navigate")
					.length === 1,
		)
		const second = page.goto("https://example.com/same-document", {
			timeoutMs: 500,
		})

		await expect(first).rejects.toThrow("superseded")
		await second
		page.disposeResources()
		detach()
	})

	test("an existing child can become root without creating a cycle", () => {
		const registry = new FrameRegistry("target", "F0")
		registry.onFrameAttached("F1", "F0", "session")
		registry.onFrameAttached("F2", "F1", "session")
		registry.onFrameNavigated(
			{
				id: "F2",
				loaderId: "loader-promoted",
				url: "https://example.com/promoted",
			} as never,
			"session",
		)

		expect(registry.mainFrameId()).toBe("F2")
		expect(registry.listAllFrames()).toEqual(["F2", "F1"])
		const tree = registry.asProtocolFrameTree("F2")
		expect(tree.frame.id).toBe("F2")
		expect(tree.childFrames?.[0]?.frame.id).toBe("F1")
		expect(tree.childFrames?.[0]?.childFrames).toBeUndefined()
	})

	test("root attachment updates the main-frame wrapper and ownership index", async () => {
		const { session, page, detach } = await createPage()
		page.onFrameAttached("F1", null, session)
		expect(page.mainFrameId()).toBe("F1")
		expect(page.mainFrame().frameId).toBe("F1")
		page.disposeResources()
		detach()

		const registry = new FrameRegistry("target", "F0")
		registry.onFrameNavigated(
			{ id: "F0", loaderId: "loader-old", url: "about:blank" } as never,
			"session",
		)
		registry.onFrameAttached("F1", null, "session")
		expect(registry.framesForSession("session")).toEqual(["F1"])
	})

	test("a response arriving before a root swap is retained", async () => {
		const { session, page, detach } = await createPage()
		session.responses.set("Page.navigate", {
			frameId: "F1",
			loaderId: "loader-root-swap",
		})
		const navigating = page.goto("https://example.com/root-swap", {
			timeoutMs: 500,
		})
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.navigate"),
		)
		session.emit("Network.responseReceived", {
			requestId: "request-root-swap",
			loaderId: "loader-root-swap",
			timestamp: 1,
			type: "Document",
			frameId: "F1",
			response: {
				url: "https://example.com/root-swap",
				status: 200,
				statusText: "OK",
				headers: {},
				mimeType: "text/html",
				charset: "utf-8",
				connectionReused: false,
				connectionId: 1,
				encodedDataLength: 0,
				securityState: "secure",
			},
		})
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 72,
				origin: "",
				name: "",
				uniqueId: "context-root-swap",
				auxData: { frameId: "F1", isDefault: true },
			},
		})
		page.onFrameNavigated(
			{
				id: "F1",
				loaderId: "loader-root-swap",
				url: "https://example.com/root-swap",
			} as never,
			session,
		)
		session.emit("Page.frameNavigated", {
			frame: {
				id: "F1",
				loaderId: "loader-root-swap",
				url: "https://example.com/root-swap",
			},
			type: "Navigation",
		})

		const response = await navigating
		expect(response?.url()).toBe("https://example.com/root-swap")
		page.disposeResources()
		detach()
	})
})
