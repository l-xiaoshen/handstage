import { describe, expect, test } from "bun:test"
import { Context } from "../src/v3/understudy/context"
import { FakeConnection } from "./_fakes"

describe("Context multi-context isolation", () => {
	test("close on an isolated context disposes its browser context", async () => {
		const conn = new FakeConnection()
		const ctx = await Context.createIsolatedFromConnection(conn)
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
		const ctx = await Context.createDefaultFromConnection(conn)
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
