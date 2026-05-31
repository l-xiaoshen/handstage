/// <reference lib="dom" />

/**
 * Real-Chrome integration tests.
 *
 * Unlike the other suites in this folder (which drive in-memory CDP fakes),
 * these tests launch an actual Chrome via both local Chrome launchers and
 * exercise the public Handstage API end-to-end over a real CDP pipe: navigation,
 * evaluation, input, screenshots, accessibility snapshots, cookies,
 * browser-context isolation, multi-page management, and the connection
 * lifecycle (closing Handstage must terminate the browser).
 *
 * The whole suite is defined across both launchers and twice per launcher —
 * once with `headless: true` and once with `headless: false` — so the exact
 * same behaviour is verified against both a headless browser and a headful
 * (windowed) browser. Headful Chrome needs a display; the headful pass
 * self-skips when no `DISPLAY` is available so the file stays green in
 * headless-only environments.
 *
 * Chrome is resolved through `chrome-launcher` (honouring `CHROME_PATH` /
 * the `executablePath` option). If no Chrome binary can be found the whole
 * suite is skipped rather than failing, so the file is safe to run in
 * environments without a browser.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { getChromePath } from "chrome-launcher"
import { launchChromeBun } from "../src/launch/bun"
import { launchChromeNode } from "../src/launch/node"
import type { V3, V3Context } from "../src/v3"
import { connectLocal } from "../src/v3/connect/local"

function chromeIsAvailable(): boolean {
	try {
		return Boolean(getChromePath())
	} catch {
		return false
	}
}

const HAS_CHROME = chromeIsAvailable()
// A headful browser requires a windowing system; without a display the
// headful pass is skipped instead of failing.
const HAS_DISPLAY = Boolean(process.env.DISPLAY)

const LAUNCH_TIMEOUT_MS = 30_000
const TEST_TIMEOUT_MS = 30_000

/** Build a `data:` URL from inline HTML so tests need no network/server. */
function htmlDataUrl(html: string): string {
	return `data:text/html,${encodeURIComponent(html)}`
}

interface LaunchMode {
	label: string
	headless: boolean
	/** Whether this mode can run in the current environment. */
	enabled: boolean
}

interface ChromeLauncher {
	label: string
	launch: typeof launchChromeNode
}

const LAUNCH_MODES: LaunchMode[] = [
	{ label: "headless", headless: true, enabled: HAS_CHROME },
	{ label: "headful", headless: false, enabled: HAS_CHROME && HAS_DISPLAY },
]

const CHROME_LAUNCHERS: ChromeLauncher[] = [
	{ label: "node", launch: launchChromeNode },
	{ label: "bun", launch: launchChromeBun },
]

/**
 * Define the entire real-Chrome suite for a single launch mode. Called once
 * per launcher and {@link LAUNCH_MODES} entry so the same assertions run
 * against both launch implementations.
 */
function defineRealChromeSuite(
	launcher: ChromeLauncher,
	mode: LaunchMode,
): void {
	const realChrome = describe.skipIf(!mode.enabled)

	async function launchHandstage(): Promise<V3> {
		const chrome = await launcher.launch({ headless: mode.headless })
		return connectLocal(chrome)
	}

	realChrome(`real Chrome [${launcher.label}/${mode.label}]`, () => {
		let v3: V3

		beforeAll(async () => {
			v3 = await launchHandstage()
		}, LAUNCH_TIMEOUT_MS)

		afterAll(async () => {
			await v3?.close()
		})

		describe("page basics", () => {
			let context: V3Context

			beforeAll(async () => {
				context = await v3.createBrowserContext({ disposeOnDetach: true })
			})

			afterAll(async () => {
				await context?.close()
			})

			test.serial(
				"navigates to a data URL and reports url + title",
				async () => {
					const url = htmlDataUrl(
						"<!doctype html><title>Hello Handstage</title><h1>Hi</h1>",
					)
					const page = await context.newPage(url)
					await page.waitForLoadState("domcontentloaded")

					expect(page.url()).toBe(url)
					expect(await page.title()).toBe("Hello Handstage")

					await page.close()
				},
				TEST_TIMEOUT_MS,
			)

			test.serial(
				"evaluate runs JS in the page and returns serializable values",
				async () => {
					const page = await context.newPage(
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

			test.serial(
				"waitForSelector resolves once an element is inserted",
				async () => {
					const page = await context.newPage(
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

			test.serial(
				"click dispatches a real mouse event at viewport coordinates",
				async () => {
					const page = await context.newPage(
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

			test.serial(
				"type sends keystrokes into the focused input",
				async () => {
					const page = await context.newPage(
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

			test.serial(
				"screenshot returns PNG-encoded bytes",
				async () => {
					const page = await context.newPage(
						htmlDataUrl(
							"<!doctype html><body style='background:#09f'>shot</body>",
						),
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

			test.serial(
				"snapshot captures the accessibility tree with element text",
				async () => {
					const page = await context.newPage(
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

			test.serial(
				"locator.count reflects the number of matching elements",
				async () => {
					const page = await context.newPage(
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

			test.serial(
				"reload re-runs the document",
				async () => {
					const page = await context.newPage(
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

		describe("pages & contexts", () => {
			let context: V3Context

			beforeAll(async () => {
				context = await v3.createBrowserContext({ disposeOnDetach: true })
			})

			afterAll(async () => {
				await context?.close()
			})

			test.serial(
				"newPage / pages / page.close track open tabs",
				async () => {
					const before = context.pages().length

					const p1 = await context.newPage("about:blank")
					const p2 = await context.newPage("about:blank")
					expect(context.pages().length).toBe(before + 2)

					await p1.close()
					// Allow the Target.detachedFromTarget event to propagate.
					await new Promise((r) => setTimeout(r, 200))
					expect(context.pages().length).toBe(before + 1)

					await p2.close()
				},
				TEST_TIMEOUT_MS,
			)

			test.serial(
				"cookies can be added, read back, and cleared on a context",
				async () => {
					await context.addCookies([
						{
							name: "ds_token",
							value: "abc123",
							url: "https://example.com/",
						},
					])

					const cookies = await context.cookies("https://example.com/")
					const found = cookies.find((c) => c.name === "ds_token")
					expect(found?.value).toBe("abc123")

					await context.clearCookies()
					const afterClear = await context.cookies("https://example.com/")
					expect(afterClear.find((c) => c.name === "ds_token")).toBeUndefined()
				},
				TEST_TIMEOUT_MS,
			)

			test.serial(
				"isolated browser contexts do not share cookies",
				async () => {
					const isolated = await v3.createBrowserContext({
						disposeOnDetach: true,
					})
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

						// The group context must not see the isolated context's cookie.
						const groupCookies = await context.cookies("https://example.com/")
						expect(
							groupCookies.find((c) => c.name === "iso_only"),
						).toBeUndefined()
					} finally {
						await isolated.close()
					}
				},
				TEST_TIMEOUT_MS,
			)
		})
	})

	realChrome(
		`real Chrome [${launcher.label}/${mode.label}] — connection lifecycle`,
		() => {
			test.serial(
				"closing Handstage terminates the launched Chrome process",
				async () => {
					const chrome = await launcher.launch({ headless: mode.headless })
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
		},
	)
}

// Run the entire suite once per launcher and launch mode.
for (const launcher of CHROME_LAUNCHERS) {
	for (const mode of LAUNCH_MODES) {
		defineRealChromeSuite(launcher, mode)
	}
}
