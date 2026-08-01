import { describe, expect, test } from "bun:test"
import type { Protocol } from "devtools-protocol"
import { executionContexts } from "../src/v3/understudy/executionContextRegistry"
import { Frame } from "../src/v3/understudy/frame"
import { Page } from "../src/v3/understudy/page"
import { installV3PiercerIntoSession } from "../src/v3/understudy/piercer"
import {
	releaseObjectGroup,
	releaseObjectIds,
} from "../src/v3/understudy/runtimeObjectUtils"
import {
	applyMaskOverlays,
	applyStyleToFrames,
	setTransparentBackground,
} from "../src/v3/understudy/screenshotUtils"
import { FakeConnection, FakeSession, waitFor } from "./_fakes"

function attachMainWorld(
	session: FakeSession,
	frameId: string,
	contextId: number,
): () => void {
	const detach = executionContexts.attachSession(session)
	session.emit("Runtime.executionContextCreated", {
		context: {
			id: contextId,
			origin: "",
			name: "",
			uniqueId: `context-${contextId}`,
			auxData: { frameId, isDefault: true },
		},
	})
	return detach
}

function releasedGroups(session: FakeSession): string[] {
	return session.sent
		.filter((entry) => entry.method === "Runtime.releaseObjectGroup")
		.map((entry) => (entry.params as { objectGroup: string }).objectGroup)
}

async function withGuard<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer!: ReturnType<typeof setTimeout>
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs)
	})
	try {
		return await Promise.race([operation, guard])
	} finally {
		clearTimeout(timer)
	}
}

describe("browser object lifecycle", () => {
	test("piercer accepts transient current-context loss after preload registration", async () => {
		const transientSession = new FakeSession("piercer-transient")
		transientSession.responses.set("Runtime.evaluate", () => {
			throw new Error("Cannot find context with specified id")
		})

		expect(await installV3PiercerIntoSession(transientSession)).toBe(true)
		const transientEvaluation = transientSession.sent.find(
			(entry) => entry.method === "Runtime.evaluate",
		)
		if (!transientEvaluation) {
			throw new Error("Expected Runtime.evaluate to be sent")
		}
		const transientGroup = (
			transientEvaluation.params as { objectGroup: string }
		).objectGroup
		expect(releasedGroups(transientSession)).toContain(transientGroup)

		const terminalSession = new FakeSession("piercer-terminal")
		terminalSession.responses.set("Runtime.evaluate", () => {
			throw new Error("Session with given id not found")
		})
		expect(await installV3PiercerIntoSession(terminalSession)).toBe(false)

		const navigatedSession = new FakeSession("piercer-navigated")
		navigatedSession.responses.set("Runtime.evaluate", () => {
			throw new Error("Inspected target navigated or closed")
		})
		expect(await installV3PiercerIntoSession(navigatedSession)).toBe(true)

		const noPreloadSession = new FakeSession("piercer-no-preload")
		noPreloadSession.responses.set(
			"Page.addScriptToEvaluateOnNewDocument",
			() => {
				throw new Error("preload registration failed")
			},
		)
		noPreloadSession.responses.set("Runtime.evaluate", {
			result: { type: "undefined" },
		})
		expect(await installV3PiercerIntoSession(noPreloadSession)).toBe(false)

		const cancelledSession = new FakeSession("piercer-cancelled")
		const controller = new AbortController()
		cancelledSession.responses.set("Runtime.evaluate", () => {
			controller.abort(new Error("piercer cancelled"))
			return { result: { type: "undefined" } }
		})
		expect(
			await installV3PiercerIntoSession(cancelledSession, controller.signal),
		).toBe(false)
	})

	test("remote cleanup keeps its deadline when given a caller signal", async () => {
		const session = new FakeSession("bounded-remote-cleanup")
		const blackhole = new Promise<never>(() => {})
		session.responses.set("Runtime.releaseObject", blackhole)
		session.responses.set("Runtime.releaseObjectGroup", blackhole)
		const signal = new AbortController().signal
		const startedAt = Date.now()

		await withGuard(
			Promise.all([
				releaseObjectIds(session, ["object-1"], signal),
				releaseObjectGroup(session, "group-1", signal),
			]).then(() => {}),
			1750,
			"remote cleanup exceeded its internal deadline",
		)

		expect(Date.now() - startedAt).toBeLessThan(1500)
		expect(session.sent.map(({ method }) => method)).toContain(
			"Runtime.releaseObject",
		)
		expect(session.sent.map(({ method }) => method)).toContain(
			"Runtime.releaseObjectGroup",
		)
	})

	test("piercer observes abort during blackholed group finalization", async () => {
		const session = new FakeSession("piercer-finalization-abort")
		session.responses.set("Runtime.evaluate", {
			result: { type: "undefined" },
		})
		session.responses.set(
			"Runtime.releaseObjectGroup",
			new Promise<never>(() => {}),
		)
		const controller = new AbortController()
		const installing = installV3PiercerIntoSession(session, controller.signal)
		await waitFor(() => releasedGroups(session).length === 1)
		const startedAt = Date.now()

		controller.abort(new Error("piercer finalization cancelled"))
		const installed = await withGuard(
			installing,
			500,
			"piercer abort waited for group cleanup",
		)

		expect(installed).toBe(false)
		expect(Date.now() - startedAt).toBeLessThan(500)
	})

	test("mask resolution owns the selector group through geometry consumption", async () => {
		const session = new FakeSession("selector-mask")
		const detach = attachMainWorld(session, "F0", 41)
		const frame = new Frame(session, "F0", "P0", false)
		const signal = new AbortController().signal
		let selectorEvaluationCount = 0
		let selectorGroup = ""

		session.responses.set("Runtime.evaluate", (params: unknown) => {
			const request = params as Protocol.Runtime.EvaluateRequest
			if (request.returnByValue === false) {
				selectorEvaluationCount += 1
				selectorGroup = request.objectGroup ?? selectorGroup
				if (selectorEvaluationCount === 1) {
					return { result: { type: "object", objectId: "selector-node" } }
				}
				return { result: { type: "undefined" } }
			}
			return { result: { type: "undefined" } }
		})
		session.responses.set("DOM.requestNode", { nodeId: 7 })
		session.responses.set("Runtime.callFunctionOn", (params: unknown) => {
			const request = params as Protocol.Runtime.CallFunctionOnRequest
			expect(request.objectGroup).toBe(selectorGroup)
			expect(releasedGroups(session)).not.toContain(selectorGroup)
			return {
				result: {
					type: "object",
					value: { x: 1, y: 2, width: 30, height: 40 },
				},
			}
		})

		const cleanup = await applyMaskOverlays(
			[frame.locator("text=masked")],
			"#ff00ff",
			signal,
		)

		expect(selectorGroup.startsWith("handstage-selector-")).toBe(true)
		expect(releasedGroups(session)).toContain(selectorGroup)
		expect(
			releasedGroups(session).some((group) => group.startsWith("__v3_mask_")),
		).toBe(false)
		await cleanup(signal)
		detach()
	})

	test("screenshot rollback evaluates after page disposal and remains bounded", async () => {
		const connection = new FakeConnection()
		const session = new FakeSession("screenshot-disposal")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		let page: Page | null = null
		let evaluationCount = 0
		session.responses.set("Runtime.evaluate", () => {
			evaluationCount += 1
			if (evaluationCount === 1) {
				page?.disposeResources()
				return { result: { type: "undefined" } }
			}
			return new Promise<never>(() => {})
		})
		const detach = attachMainWorld(session, "F0", 42)
		page = await Page.create(connection, session, "screenshot-target", null)
		const frame = page.mainFrame()
		const rollback = applyStyleToFrames(
			[frame],
			"body { visibility: hidden; }",
			"disposal",
			page.disposalSignal(),
		)
		let rejectGuard!: (error: Error) => void
		const guard = new Promise<never>((_, reject) => {
			rejectGuard = reject
		})
		const timer = setTimeout(
			() => rejectGuard(new Error("screenshot rollback hung")),
			1500,
		)
		try {
			await expect(Promise.race([rollback, guard])).rejects.toThrow(
				"page is disposed",
			)
		} finally {
			clearTimeout(timer)
		}

		expect(evaluationCount).toBe(2)
		detach()
	})

	test("screenshot rollback stops waiting for cleanup on a later abort", async () => {
		const session = new FakeSession("screenshot-cleanup-abort")
		let commandCount = 0
		session.responses.set("Emulation.setDefaultBackgroundColorOverride", () => {
			commandCount += 1
			if (commandCount === 1) {
				throw new Error("background setup failed")
			}
			return new Promise<never>(() => {})
		})
		const controller = new AbortController()
		const settingBackground = setTransparentBackground(
			session,
			controller.signal,
		)
		await waitFor(() => commandCount === 2)
		const startedAt = Date.now()

		controller.abort(new Error("screenshot timed out during rollback"))
		await expect(
			withGuard(
				settingBackground,
				500,
				"screenshot rollback ignored operation abort",
			),
		).rejects.toThrow("background setup failed")
		expect(Date.now() - startedAt).toBeLessThan(500)
	})

	test("abortable frame evaluation releases its unique group and still retries", async () => {
		const session = new FakeSession("frame-evaluation")
		const detach = attachMainWorld(session, "F0", 43)
		const frame = new Frame(session, "F0", "P0", false)
		let finishLateEvaluation!: (
			response: Protocol.Runtime.EvaluateResponse,
		) => void
		session.responses.set(
			"Runtime.evaluate",
			new Promise<Protocol.Runtime.EvaluateResponse>((resolve) => {
				finishLateEvaluation = resolve
			}),
		)
		const controller = new AbortController()
		const evaluating = frame.evaluate(
			"window.pending",
			undefined,
			controller.signal,
		)
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		)
		const abortedRequest = session.sent.find(
			(entry) => entry.method === "Runtime.evaluate",
		)?.params as Protocol.Runtime.EvaluateRequest
		const abortedGroup = abortedRequest.objectGroup
		if (!abortedGroup) {
			throw new Error("expected an evaluation object group")
		}

		controller.abort(new Error("evaluation cancelled"))
		await expect(evaluating).rejects.toThrow("evaluation cancelled")
		await waitFor(() => releasedGroups(session).includes(abortedGroup))
		const releasesBeforeLateResult = releasedGroups(session).filter(
			(group) => group === abortedGroup,
		).length
		expect(abortedRequest.returnByValue).toBe(true)
		expect(
			abortedRequest.objectGroup?.startsWith("handstage-frame-evaluate-"),
		).toBe(true)
		finishLateEvaluation({
			result: { type: "object", objectId: "late-result" },
			exceptionDetails: {
				exceptionId: 1,
				text: "late exception",
				lineNumber: 0,
				columnNumber: 0,
				exception: { type: "object", objectId: "late-exception" },
			},
		})
		await waitFor(
			() =>
				releasedGroups(session).filter((group) => group === abortedGroup)
					.length > releasesBeforeLateResult,
		)

		let retryCount = 0
		session.responses.set("Runtime.evaluate", () => {
			retryCount += 1
			if (retryCount === 1) {
				throw new Error("Cannot find context with specified id")
			}
			return { result: { type: "number", value: 17 } }
		})
		const retryStart = session.sent.length
		const value = await frame.evaluate<number>(
			"17",
			undefined,
			new AbortController().signal,
		)
		const retryRequests = session.sent
			.slice(retryStart)
			.filter((entry) => entry.method === "Runtime.evaluate")
			.map((entry) => entry.params as Protocol.Runtime.EvaluateRequest)

		expect(value).toBe(17)
		expect(retryRequests).toHaveLength(2)
		expect(retryRequests[0]?.objectGroup).toBe(retryRequests[1]?.objectGroup)
		expect(retryRequests[0]?.objectGroup).not.toBe(abortedGroup)
		detach()
	})

	test("frame evaluation observes abort during blackholed group finalization", async () => {
		const session = new FakeSession("frame-finalization-abort")
		const detach = attachMainWorld(session, "F0", 44)
		const frame = new Frame(session, "F0", "P0", false)
		session.responses.set("Runtime.evaluate", {
			result: { type: "number", value: 23 },
		})
		session.responses.set(
			"Runtime.releaseObjectGroup",
			new Promise<never>(() => {}),
		)
		const controller = new AbortController()
		const evaluating = frame.evaluate<number>(
			"23",
			undefined,
			controller.signal,
		)
		await waitFor(() => releasedGroups(session).length === 1)
		const startedAt = Date.now()

		controller.abort(new Error("frame finalization cancelled"))
		await expect(
			withGuard(evaluating, 500, "frame abort waited for group cleanup"),
		).rejects.toThrow("frame finalization cancelled")
		expect(Date.now() - startedAt).toBeLessThan(500)
		detach()
	})

	test("highlight hides an installed overlay when disposal aborts its delay", async () => {
		const session = new FakeSession("highlight-disposal")
		const disposalController = new AbortController()
		const frame = new Frame(
			session,
			"F0",
			"P0",
			false,
			undefined,
			disposalController.signal,
		)
		const locator = frame.locator("#target")
		locator.resolveNode = async () => ({
			objectId: "highlight-node",
			nodeId: 1,
		})
		session.responses.set("DOM.describeNode", {
			node: {
				nodeId: 1,
				backendNodeId: 9,
				nodeType: 1,
				nodeName: "DIV",
			},
		})
		session.responses.set("Overlay.highlightNode", () => {
			disposalController.abort(new Error("page disposed during highlight"))
			return new Promise<never>(() => {})
		})
		session.responses.set("Overlay.hideHighlight", new Promise<never>(() => {}))
		session.responses.set("Runtime.releaseObject", new Promise<never>(() => {}))
		const startedAt = Date.now()

		await expect(
			withGuard(
				locator.highlight({ durationMs: 1_000 }),
				1750,
				"highlight rollback exceeded its cleanup bound",
			),
		).rejects.toThrow("page disposed during highlight")
		expect(Date.now() - startedAt).toBeLessThan(1500)
		const methods = session.sent.map((entry) => entry.method)
		expect(methods.indexOf("Overlay.hideHighlight")).toBeGreaterThan(
			methods.indexOf("Overlay.highlightNode"),
		)
		expect(methods).toContain("Runtime.releaseObject")
	})

	test("highlight resolution is canceled by frame disposal", async () => {
		const session = new FakeSession("highlight-resolution-disposal")
		const detach = attachMainWorld(session, "F0", 61)
		const disposalController = new AbortController()
		const frame = new Frame(
			session,
			"F0",
			"P0",
			false,
			undefined,
			disposalController.signal,
		)
		session.responses.set("Runtime.evaluate", new Promise<never>(() => {}))
		const highlighting = frame.locator("#target").highlight()
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Runtime.evaluate"),
		)
		disposalController.abort(new Error("disposed during selector resolution"))

		await expect(highlighting).rejects.toThrow(
			"disposed during selector resolution",
		)
		detach()
	})
})
