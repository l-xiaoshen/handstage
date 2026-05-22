import { describe, expect, test } from "bun:test"
import type { Protocol } from "devtools-protocol"
import type {
	CDPConnectionLike,
	CDPSessionLike,
} from "../src/v3/understudy/cdp"
import { V3Context } from "../src/v3/understudy/context"
import {
	getTargetRouter,
	type TargetRouterDelegate,
} from "../src/v3/understudy/targetRouter"

type Handler = (params: unknown) => void

class FakeSession implements CDPSessionLike {
	public sent: Array<{ method: string; params?: object }> = []
	private handlers = new Map<string, Set<Handler>>()

	constructor(
		public readonly id: string,
		private readonly frameId = `frame-${id}`,
	) {}

	async send<R = unknown>(method: string, params?: object): Promise<R> {
		this.sent.push({ method, params })
		if (method === "Page.getFrameTree") {
			return {
				frameTree: {
					frame: {
						id: this.frameId,
						loaderId: `loader-${this.frameId}`,
						url: "about:blank",
						domainAndRegistry: "",
						securityOrigin: "://",
						mimeType: "text/html",
						secureContextType: "InsecureScheme",
						crossOriginIsolatedContextType: "NotIsolated",
						gatedAPIFeatures: [],
					},
				},
			} as R
		}
		return {} as R
	}

	on<P = unknown>(event: string, handler: (params: P) => void): void {
		const set = this.handlers.get(event) ?? new Set<Handler>()
		set.add(handler as Handler)
		this.handlers.set(event, set)
	}

	off<P = unknown>(event: string, handler: (params: P) => void): void {
		this.handlers.get(event)?.delete(handler as Handler)
	}

	async close(): Promise<void> {}

	emit(event: string, params: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) {
			handler(params)
		}
	}

	listenerCount(event: string): number {
		return this.handlers.get(event)?.size ?? 0
	}
}

class FakeConnection implements CDPConnectionLike {
	public readonly id: string | null = null
	public sent: Array<{ method: string; params?: object }> = []
	public autoAttachCalls = 0
	public closed = false
	public sessions = new Map<string, FakeSession>()
	public nonDefaultContextIds: string[] = []
	public targets: Protocol.Target.TargetInfo[] = []
	private handlers = new Map<string, Set<Handler>>()

	async send<R = unknown>(method: string, params?: object): Promise<R> {
		this.sent.push({ method, params })
		if (method === "Target.getBrowserContexts") {
			return {
				browserContextIds: this.nonDefaultContextIds,
			} as R
		}
		if (method === "Target.getTargets") {
			return { targetInfos: this.targets } as R
		}
		return {} as R
	}

	on<P = unknown>(event: string, handler: (params: P) => void): void {
		const set = this.handlers.get(event) ?? new Set<Handler>()
		set.add(handler as Handler)
		this.handlers.set(event, set)
	}

	off<P = unknown>(event: string, handler: (params: P) => void): void {
		this.handlers.get(event)?.delete(handler as Handler)
	}

	async close(): Promise<void> {
		this.closed = true
	}

	getSession(sessionId: string): CDPSessionLike | undefined {
		return this.sessions.get(sessionId)
	}

	async enableAutoAttach(): Promise<void> {
		this.autoAttachCalls += 1
	}

	async attachToTarget(targetId: string): Promise<CDPSessionLike> {
		const sessionId = `session-${targetId}`
		const session = new FakeSession(sessionId)
		this.sessions.set(sessionId, session)
		return session
	}

	async getTargets(): Promise<Protocol.Target.TargetInfo[]> {
		return this.targets
	}

	onTransportClosed(): void {}
	offTransportClosed(): void {}

	waitForSessionDispatch(): Promise<void> {
		return Promise.resolve()
	}

	emit(event: string, params: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) {
			handler(params)
		}
	}
}

function pageTarget(
	targetId: string,
	browserContextId?: string,
	type: "page" | "iframe" = "page",
): Protocol.Target.TargetInfo {
	return {
		targetId,
		type,
		title: "",
		url: "about:blank",
		attached: false,
		canAccessOpener: false,
		browserContextId,
	} as Protocol.Target.TargetInfo
}

function attachedEvent(
	sessionId: string,
	targetInfo: Protocol.Target.TargetInfo,
): Protocol.Target.AttachedToTargetEvent {
	return {
		sessionId,
		targetInfo,
		waitingForDebugger: true,
	}
}

async function waitFor(assertion: () => boolean): Promise<void> {
	const deadline = Date.now() + 500
	while (Date.now() < deadline) {
		if (assertion()) return
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	expect(assertion()).toBe(true)
}

describe("TargetRouter", () => {
	test("resumes and detaches unclaimed auto-attached targets", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-foreign")
		conn.sessions.set(session.id, session)
		const router = getTargetRouter(conn)
		let claimed = false
		const delegate: TargetRouterDelegate = {
			canClaimTarget: () => false,
			onRouterAttachedToTarget: () => {
				claimed = true
			},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
			onRouterTargetCreated: () => {},
		}
		const unregister = await router.register(delegate)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("foreign", "ctx-foreign")),
		)

		await waitFor(() =>
			session.sent.some(
				(entry) => entry.method === "Runtime.runIfWaitingForDebugger",
			),
		)
		expect(claimed).toBe(false)
		expect(
			conn.sent.some(
				(entry) =>
					entry.method === "Target.detachFromTarget" &&
					(entry.params as { sessionId?: string })?.sessionId === session.id,
			),
		).toBe(true)
		unregister()
	})

	test("dispatches a claimed target to exactly one delegate", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-owned")
		conn.sessions.set(session.id, session)
		const router = getTargetRouter(conn)
		const calls: string[] = []
		const first: TargetRouterDelegate = {
			canClaimTarget: (info) => info.browserContextId === "ctx-owned",
			onRouterAttachedToTarget: async () => {
				calls.push("first")
				await session.send("Runtime.runIfWaitingForDebugger")
			},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
			onRouterTargetCreated: () => {},
		}
		const second: TargetRouterDelegate = {
			canClaimTarget: () => true,
			onRouterAttachedToTarget: () => {
				calls.push("second")
			},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
			onRouterTargetCreated: () => {},
		}
		const unregisterFirst = await router.register(first)
		const unregisterSecond = await router.register(second)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("owned", "ctx-owned")),
		)

		await waitFor(() => calls.length === 1)
		expect(calls).toEqual(["first"])
		expect(
			session.sent.some(
				(entry) => entry.method === "Runtime.runIfWaitingForDebugger",
			),
		).toBe(true)
		unregisterFirst()
		unregisterSecond()
	})
})

describe("V3Context default-context routing", () => {
	test("does not create a temporary target for default-context bootstrap", async () => {
		const conn = new FakeConnection()
		const ctx = await V3Context.createDefaultFromConnection(conn)

		expect(
			conn.sent.some((entry) => entry.method === "Target.createTarget"),
		).toBe(false)
		await ctx.close()
	})

	test("does not claim known non-default browser contexts", async () => {
		const conn = new FakeConnection()
		conn.nonDefaultContextIds = ["ctx-dedicated"]
		const session = new FakeSession("s-dedicated")
		conn.sessions.set(session.id, session)
		const ctx = await V3Context.createDefaultFromConnection(conn)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(
				session.id,
				pageTarget("dedicated-target", "ctx-dedicated"),
			),
		)

		await waitFor(() =>
			session.sent.some(
				(entry) => entry.method === "Runtime.runIfWaitingForDebugger",
			),
		)
		expect(ctx.pages()).toHaveLength(0)
		expect(
			conn.sent.some(
				(entry) =>
					entry.method === "Target.detachFromTarget" &&
					(entry.params as { sessionId?: string })?.sessionId === session.id,
			),
		).toBe(true)
		await ctx.close()
	})

	test("releases observed default-context pages without closing unowned targets", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-default", "main-frame")
		conn.sessions.set(session.id, session)
		const ctx = await V3Context.createDefaultFromConnection(conn)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("default-target")),
		)

		await waitFor(() => ctx.pages().length === 1)
		await ctx.close()

		expect(
			conn.sent.some(
				(entry) =>
					entry.method === "Target.closeTarget" &&
					(entry.params as { targetId?: string })?.targetId ===
						"default-target",
			),
		).toBe(false)
		expect(conn.closed).toBe(true)
		expect(session.listenerCount("Network.requestWillBeSent")).toBe(0)
		expect(session.listenerCount("Runtime.consoleAPICalled")).toBe(0)
	})

	test("cleans tracked OOPIF frame and network listeners on detach", async () => {
		const conn = new FakeConnection()
		const parent = new FakeSession("s-parent", "main-frame")
		const child = new FakeSession("s-child", "child-frame")
		conn.sessions.set(parent.id, parent)
		conn.sessions.set(child.id, child)
		const ctx = await V3Context.createDefaultFromConnection(conn)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(parent.id, pageTarget("parent-target")),
		)
		await waitFor(() => ctx.pages().length === 1)

		parent.emit("Page.frameAttached", {
			frameId: "child-frame",
			parentFrameId: "main-frame",
		} satisfies Protocol.Page.FrameAttachedEvent)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(child.id, pageTarget("child-target", undefined, "iframe")),
		)
		await waitFor(() => child.listenerCount("Page.frameAttached") > 0)
		expect(child.listenerCount("Page.frameNavigated")).toBeGreaterThan(0)
		expect(child.listenerCount("Network.requestWillBeSent")).toBeGreaterThan(0)

		conn.emit("Target.detachedFromTarget", {
			sessionId: child.id,
			targetId: "child-target",
		} satisfies Protocol.Target.DetachedFromTargetEvent)

		await waitFor(() => child.listenerCount("Page.frameAttached") === 0)
		expect(child.listenerCount("Page.frameNavigated")).toBe(0)
		expect(child.listenerCount("Page.frameDetached")).toBe(0)
		expect(child.listenerCount("Page.navigatedWithinDocument")).toBe(0)
		expect(child.listenerCount("Page.windowOpen")).toBe(0)
		expect(child.listenerCount("Network.requestWillBeSent")).toBe(0)
		expect(child.listenerCount("Network.loadingFinished")).toBe(0)

		await ctx.close()
	})
})
