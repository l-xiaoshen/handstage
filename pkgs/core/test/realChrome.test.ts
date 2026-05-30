/**
 * Real-Chrome integration tests.
 *
 * Unlike the other suites in this folder (which drive in-memory CDP fakes),
 * these tests launch an actual headless Chrome via `launchChromeNode` and
 * exercise the public Handstage API end-to-end over a real CDP pipe:
 * navigation, evaluation, input, screenshots, accessibility snapshots,
 * cookies, browser-context isolation, multi-page management, and the
 * connection lifecycle (closing Handstage must terminate the browser).
 *
 * Chrome is resolved through `chrome-launcher` (honouring `CHROME_PATH` /
 * the `executablePath` option). If no Chrome binary can be found the whole
 * suite is skipped rather than failing, so the file is safe to run in
 * environments without a browser.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { getChromePath } from "chrome-launcher"
import { launchChromeNode } from "../src/launch/node"
import { connectLocal } from "../src/v3/connect/local"
import type { V3 } from "../src/v3/v3"

function chromeIsAvailable(): boolean {
	try {
		return Boolean(getChromePath())
	} catch {
		return false
	}
}

const HAS_CHROME = chromeIsAvailable()
// `describe.skipIf` keeps the suite green on machines without Chrome while
// still running for real wherever a browser binary exists.
const realChrome = describe.skipIf(!HAS_CHROME)

const LAUNCH_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 30_000

/** Build a `data:` URL from inline HTML so tests need no network/server. */
function htmlDataUrl(html: string): string {
	return `data:text/html,${encodeURIComponent(html)}`
}

async function launchHandstage(): Promise<V3> {
	const chrome = await launchChromeNode({ headless: true })
	return connectLocal(chrome)
}

realChrome("real Chrome — page basics", () => {
	let v3: V3

	beforeAll(async () => {
		v3 = await launchHandstage()
	}, LAUNCH_TIMEOUT_MS)

	afterAll(async () => {
		await v3?.close()
	})

	test(
		"navigates to a data URL and reports url + title",
		async () => {
			const url = htmlDataUrl(
				"<!doctype html><title>Hello Handstage</title><h1>Hi</h1>",
			)
			const page = await v3.newPage(url)
			await page.waitForLoadState("domcontentloaded")

			expect(page.url()).toBe(url)
			expect(await page.title()).toBe("Hello Handstage")

			await page.close()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"evaluate runs JS in the page and returns serializable values",
		async () => {
			const page = await v3.newPage(
				htmlDataUrl("<!doctype html><body><p>x</p></body>"),
			)
			await page.waitForLoadState("domcontentloaded")

			const sum = await page.evaluate(() => 6 * 7)
			expect(sum).toBe(42)

			const info = await page.evaluate(() => ({
				tag: document.querySelector("p")?.tagName,
				ua: typeof navigator.userAgent === "string",
			}))
			expect(info).toEqual({ tag: "P", ua: true })

			await page.close()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"waitForSelector resolves once an element is inserted",
		async () => {
			const page = await v3.newPage(
				htmlDataUrl(
					"<!doctype html><body><script>setTimeout(()=>{const d=document.createElement('div');d.id='late';d.textContent='ready';document.body.appendChild(d)},150)</script></body>",
				),
			)
			await page.waitForLoadState("domcontentloaded")

			const found = await page.waitForSelector("#late", { timeout: 5000 })
			expect(found).toBe(true)

			const text = await page.evaluate(
				() => document.getElementById("late")?.textContent,
			)
			expect(text).toBe("ready")

			await page.close()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"click dispatches a real mouse event at viewport coordinates",
		async () => {
			const page = await v3.newPage(
				htmlDataUrl(
					"<!doctype html><body style='margin:0'><script>window.__clicks=0;document.addEventListener('click',e=>{window.__clicks++;window.__last=[e.clientX,e.clientY]})</script></body>",
				),
			)
			await page.waitForLoadState("domcontentloaded")
			await page.bringToFront()

			await page.click(40, 50)

			const clicks = await page.evaluate(
				() => (window as unknown as { __clicks: number }).__clicks,
			)
			const last = await page.evaluate(
				() => (window as unknown as { __last: [number, number] }).__last,
			)
			expect(clicks).toBe(1)
			expect(last).toEqual([40, 50])

			await page.close()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"type sends keystrokes into the focused input",
		async () => {
			const page = await v3.newPage(
				htmlDataUrl("<!doctype html><body><input id='i'></body>"),
			)
			await page.waitForLoadState("domcontentloaded")
			await page.bringToFront()

			await page.evaluate(() => {
				;(document.getElementById("i") as HTMLInputElement).focus()
			})
			await page.type("handstage")

			const value = await page.evaluate(
				() => (document.getElementById("i") as HTMLInputElement).value,
			)
			expect(value).toBe("handstage")

			await page.close()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"screenshot returns PNG-encoded bytes",
		async () => {
			const page = await v3.newPage(
				htmlDataUrl("<!doctype html><body style='background:#09f'>shot</body>"),
			)
			await page.waitForLoadState("load")

			const buf = await page.screenshot()
			expect(buf.length).toBeGreaterThan(100)
			// PNG magic number: 89 50 4E 47 0D 0A 1A 0A
			expect(Array.from(buf.subarray(0, 8))).toEqual([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			])

			await page.close()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"snapshot captures the accessibility tree with element text",
		async () => {
			const page = await v3.newPage(
				htmlDataUrl(
					"<!doctype html><body><button>Click Me</button><a href='https://example.com'>Link</a></body>",
				),
			)
			await page.waitForLoadState("domcontentloaded")

			const snap = await page.snapshot()
			expect(typeof snap.formattedTree).toBe("string")
			expect(snap.formattedTree).toContain("Click Me")

			await page.close()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"locator.count reflects the number of matching elements",
		async () => {
			const page = await v3.newPage(
				htmlDataUrl(
					"<!doctype html><body><ul><li class='row'>a</li><li class='row'>b</li><li class='row'>c</li></ul></body>",
				),
			)
			await page.waitForLoadState("domcontentloaded")

			const count = await page.locator(".row").count()
			expect(count).toBe(3)

			await page.close()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"reload re-runs the document",
		async () => {
			const page = await v3.newPage(
				htmlDataUrl(
					"<!doctype html><body><script>window.__loadId=Date.now()+Math.random()</script></body>",
				),
			)
			await page.waitForLoadState("domcontentloaded")
			const first = await page.evaluate(
				() => (window as unknown as { __loadId: number }).__loadId,
			)

			await page.reload({ waitUntil: "domcontentloaded" })
			const second = await page.evaluate(
				() => (window as unknown as { __loadId: number }).__loadId,
			)

			expect(typeof first).toBe("number")
			expect(typeof second).toBe("number")
			expect(second).not.toBe(first)

			await page.close()
		},
		TEST_TIMEOUT_MS,
	)
})

realChrome("real Chrome — pages & contexts", () => {
	let v3: V3

	beforeAll(async () => {
		v3 = await launchHandstage()
	}, LAUNCH_TIMEOUT_MS)

	afterAll(async () => {
		await v3?.close()
	})

	test(
		"newPage / pages / page.close track open tabs",
		async () => {
			const before = v3.pages().length

			const p1 = await v3.newPage("about:blank")
			const p2 = await v3.newPage("about:blank")
			expect(v3.pages().length).toBe(before + 2)

			await p1.close()
			// Allow the Target.detachedFromTarget event to propagate.
			await new Promise((r) => setTimeout(r, 200))
			expect(v3.pages().length).toBe(before + 1)

			await p2.close()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"cookies can be added, read back, and cleared on a context",
		async () => {
			const ctx = v3.defaultBrowserContext()
			await ctx.addCookies([
				{
					name: "ds_token",
					value: "abc123",
					url: "https://example.com/",
				},
			])

			const cookies = await ctx.cookies("https://example.com/")
			const found = cookies.find((c) => c.name === "ds_token")
			expect(found?.value).toBe("abc123")

			await ctx.clearCookies()
			const afterClear = await ctx.cookies("https://example.com/")
			expect(afterClear.find((c) => c.name === "ds_token")).toBeUndefined()
		},
		TEST_TIMEOUT_MS,
	)

	test(
		"isolated browser contexts do not share cookies",
		async () => {
			const isolated = await v3.createBrowserContext({ disposeOnDetach: true })
			try {
				await isolated.addCookies([
					{
						name: "iso_only",
						value: "secret",
						url: "https://example.com/",
					},
				])

				const isoCookies = await isolated.cookies("https://example.com/")
				expect(isoCookies.find((c) => c.name === "iso_only")?.value).toBe(
					"secret",
				)

				// The default context must not see the isolated context's cookie.
				const defaultCookies = await v3
					.defaultBrowserContext()
					.cookies("https://example.com/")
				expect(
					defaultCookies.find((c) => c.name === "iso_only"),
				).toBeUndefined()
			} finally {
				await isolated.close()
			}
		},
		TEST_TIMEOUT_MS,
	)
})

realChrome("real Chrome — connection lifecycle", () => {
	test(
		"closing Handstage terminates the launched Chrome process",
		async () => {
			const chrome = await launchChromeNode({ headless: true })
			const pid = chrome.pid
			expect(typeof pid).toBe("number")

			const v3 = await connectLocal(chrome)
			const page = await v3.newPage("about:blank")
			expect(await page.evaluate(() => 1 + 1)).toBe(2)

			await v3.close()

			// After close the browser process should be gone. Poll briefly to
			// avoid racing the asynchronous kill.
			const stillAlive = (p: number): boolean => {
				try {
					process.kill(p, 0)
					return true
				} catch {
					return false
				}
			}
			const deadline = Date.now() + 5000
			while (Date.now() < deadline && stillAlive(pid as number)) {
				await new Promise((r) => setTimeout(r, 100))
			}
			expect(stillAlive(pid as number)).toBe(false)
		},
		LAUNCH_TIMEOUT_MS,
	)
})
