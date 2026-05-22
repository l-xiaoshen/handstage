import { describe, expect, test } from "bun:test"
import { V3Context } from "../src/v3/understudy/context"
import {
	getTargetRouter,
	type TargetRouterDelegate,
} from "../src/v3/understudy/targetRouter"
import {
	attachedEvent,
	FakeConnection,
	FakeSession,
	pageTarget,
	waitFor,
} from "./_fakes"

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
		}
		const second: TargetRouterDelegate = {
			canClaimTarget: () => true,
			onRouterAttachedToTarget: () => {
				calls.push("second")
			},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
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

	test("fans router-level debug logs out to every registered delegate", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-router-log")
		conn.sessions.set(session.id, session)
		const router = getTargetRouter(conn)

		const aLines: string[] = []
		const bLines: string[] = []
		const aDelegate: TargetRouterDelegate = {
			canClaimTarget: () => {
				throw new Error("a-boom")
			},
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		const bDelegate: TargetRouterDelegate = {
			canClaimTarget: () => false,
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}

		const unA = await router.register(aDelegate, (line) =>
			aLines.push(line.message),
		)
		const unB = await router.register(bDelegate, (line) =>
			bLines.push(line.message),
		)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(
				session.id,
				pageTarget("router-log-target", "ctx-router-log"),
			),
		)

		await waitFor(() => aLines.length > 0 && bLines.length > 0)
		expect(
			aLines.some((m) => m.includes("Target ownership predicate failed")),
		).toBe(true)
		expect(
			bLines.some((m) => m.includes("Target ownership predicate failed")),
		).toBe(true)
		unA()
		unB()
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
})
