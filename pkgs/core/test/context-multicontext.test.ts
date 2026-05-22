import { describe, expect, test } from "bun:test"
import { V3 } from "../src/v3/index"

describe("same-CDP multi-context isolation", () => {
	test(
		"multiple Handstage clients share a CDP websocket without sharing context state",
		async () => {
			const server = Bun.serve({
				port: 0,
				fetch(request) {
					const url = new URL(request.url)
					const label = url.pathname.replace("/", "") || "root"
					return new Response(
						`<!doctype html><title>${label}</title><h1>${label}</h1>`,
						{ headers: { "content-type": "text/html" } },
					)
				},
			})
			const baseUrl = server.url.toString().replace(/\/$/, "")

			const h1 = await V3.connectLocal({
				localBrowserLaunchOptions: { headless: true },
			})
			let h2: V3 | null = null
			let h3: V3 | null = null

			try {
				const ws = h1.connectURL()
				;[h2, h3] = await Promise.all([
					V3.connectLocal({ localBrowserLaunchOptions: { cdpUrl: ws } }),
					V3.connectLocal({ localBrowserLaunchOptions: { cdpUrl: ws } }),
				])

				expect(h1.context.browserContextId).not.toBe(h2.context.browserContextId)
				expect(h1.context.browserContextId).not.toBe(h3.context.browserContextId)
				expect(h2.context.browserContextId).not.toBe(h3.context.browserContextId)
				expect(h1.context.pages()).toHaveLength(0)
				expect(h2.context.pages()).toHaveLength(0)
				expect(h3.context.pages()).toHaveLength(0)

				await Promise.all([
					h1.context.addCookies([
						{ name: "client", value: "one", url: baseUrl },
					]),
					h2.context.addCookies([
						{ name: "client", value: "two", url: baseUrl },
					]),
					h3.context.addCookies([
						{ name: "client", value: "three", url: baseUrl },
					]),
				])

				const [p1, p2, p3] = await Promise.all([
					h1.context.newPage(`${baseUrl}/one`),
					h2.context.newPage(`${baseUrl}/two`),
					h3.context.newPage(`${baseUrl}/three`),
				])
				await Promise.all([
					p1.waitForLoadState("domcontentloaded", 5000),
					p2.waitForLoadState("domcontentloaded", 5000),
					p3.waitForLoadState("domcontentloaded", 5000),
				])

				expect(h1.context.pages()).toHaveLength(1)
				expect(h2.context.pages()).toHaveLength(1)
				expect(h3.context.pages()).toHaveLength(1)
				expect(await p1.title()).toBe("one")
				expect(await p2.title()).toBe("two")
				expect(await p3.title()).toBe("three")

				const [c1, c2, c3] = await Promise.all([
					h1.context.cookies(baseUrl),
					h2.context.cookies(baseUrl),
					h3.context.cookies(baseUrl),
				])
				expect(c1.find((c) => c.name === "client")?.value).toBe("one")
				expect(c2.find((c) => c.name === "client")?.value).toBe("two")
				expect(c3.find((c) => c.name === "client")?.value).toBe("three")

				await h2.close()
				h2 = null

				expect(await p1.title()).toBe("one")
				expect(await p3.title()).toBe("three")
				expect(h1.context.pages()).toHaveLength(1)
				expect(h3.context.pages()).toHaveLength(1)
			} finally {
				await h3?.close().catch(() => {})
				await h2?.close().catch(() => {})
				await h1.close().catch(() => {})
				server.stop(true)
			}
		},
		30_000,
	)
})
