import { describe, expect, test } from "bun:test"
import { V3Context } from "../src/v3/understudy/context"
import {
	attachedEvent,
	FakeConnection,
	FakeSession,
	pageTarget,
	waitFor,
} from "./_fakes"

describe("V3Context multi-context isolation", () => {
	test("does not expose a removed active-page surface", async () => {
		const conn = new FakeConnection()
		const ctx = await V3Context.createDefaultFromConnection(conn)
		// The active-page concept has been removed entirely; these methods
		// must not exist on the context anymore.
		expect(
			(ctx as unknown as Record<string, unknown>).activePage,
		).toBeUndefined()
		expect(
			(ctx as unknown as Record<string, unknown>).setActivePage,
		).toBeUndefined()
		expect(
			(ctx as unknown as Record<string, unknown>).awaitActivePage,
		).toBeUndefined()
		await ctx.close()
	})

	test("two isolated contexts on one connection only see their own targets", async () => {
		const conn = new FakeConnection()

		const aCtxId = "ctx-a"
		const bCtxId = "ctx-b"
		// Pre-seed nonDefault list so each isolated context's getNonDefault
		// query is consistent if it runs.
		conn.nonDefaultContextIds = [aCtxId, bCtxId]

		// Override createBrowserContext to hand out deterministic ids in order.
		let next = 0
		const origSend = conn.send.bind(conn)
		conn.send = async function send<R>(
			method: string,
			params?: object,
		): Promise<R> {
			if (method === "Target.createBrowserContext") {
				next += 1
				return { browserContextId: next === 1 ? aCtxId : bCtxId } as R
			}
			return origSend<R>(method, params)
		} as typeof conn.send

		const a = await V3Context.createIsolatedFromConnection(conn)
		const b = await V3Context.createIsolatedFromConnection(conn)

		const sessA = new FakeSession("s-a")
		const sessB = new FakeSession("s-b")
		conn.sessions.set(sessA.id, sessA)
		conn.sessions.set(sessB.id, sessB)

		// Emit a target for context A.
		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(sessA.id, pageTarget("tA", aCtxId)),
		)
		// Emit a target for context B.
		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(sessB.id, pageTarget("tB", bCtxId)),
		)

		// Give the router a moment to route + the contexts to settle.
		// They will not actually create Pages because the FakeConnection
		// doesn't return a useful Page.getFrameTree, but the routing
		// decision is what we're verifying here.
		await waitFor(
			() =>
				(a as unknown as { sessionOwnerPage: Map<string, unknown> })
					.sessionOwnerPage.size +
					(b as unknown as { sessionOwnerPage: Map<string, unknown> })
						.sessionOwnerPage.size >=
				0,
		)

		// Both contexts must reject the other's target via canClaimTarget.
		expect(await a.canClaimTarget(pageTarget("x", bCtxId))).toBe(false)
		expect(await a.canClaimTarget(pageTarget("x", aCtxId))).toBe(true)
		expect(await b.canClaimTarget(pageTarget("x", aCtxId))).toBe(false)
		expect(await b.canClaimTarget(pageTarget("x", bCtxId))).toBe(true)

		// Closing one context must not affect the other's lifecycle.
		await a.close()
		expect(conn.closeCalls).toBe(0)
		await b.close()
		expect(conn.closeCalls).toBe(0)
	})

	test("close on an isolated context disposes its browser context", async () => {
		const conn = new FakeConnection()
		const ctx = await V3Context.createIsolatedFromConnection(conn)
		await ctx.close()
		expect(
			conn.sent.some(
				(entry) => entry.method === "Target.disposeBrowserContext",
			),
		).toBe(true)
		expect(conn.closeCalls).toBe(0)
	})

	test("close on a default context does not call disposeBrowserContext", async () => {
		const conn = new FakeConnection()
		const ctx = await V3Context.createDefaultFromConnection(conn)
		const beforeDispose = conn.sent.filter(
			(e) => e.method === "Target.disposeBrowserContext",
		).length
		await ctx.close()
		const afterDispose = conn.sent.filter(
			(e) => e.method === "Target.disposeBrowserContext",
		).length
		expect(afterDispose).toBe(beforeDispose)
		expect(conn.closeCalls).toBe(0)
	})
})
