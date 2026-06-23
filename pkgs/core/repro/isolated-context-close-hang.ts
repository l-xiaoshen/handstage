/**
 * Reproduction for: Bun process does not exit after tearing down an isolated
 * browser context, Handstage, and the launched Chrome instance.
 *
 * Flow:
 *   1. launchChromeBun
 *   2. connectLocal
 *   3. createBrowserContext → newPage
 *   4. close the isolated context
 *   5. close handstage → browser → instance
 *
 * Run:
 *   bun run pkgs/core/repro/isolated-context-close-hang.ts
 *
 * Expected: process exits on its own within a few seconds.
 * Actual (bug): process hangs with open handles after the final close calls.
 */
import { connectLocal } from "../src/v3/connect/local"
import { launchChromeBun } from "../src/launch/bun"
import { LogLevel } from "../src/v3/types/public/logs"

const HANG_TIMEOUT_MS = 10_000

const hangTimer = setTimeout(() => {
	console.error(
		`[repro] process still alive ${HANG_TIMEOUT_MS}ms after teardown — bug reproduced`,
	)
	process.exit(1)
}, HANG_TIMEOUT_MS)

const instance = await launchChromeBun({ headless: true })
const browser = instance
const handstage = await connectLocal(browser, { verbose: LogLevel.Error })

const context = await handstage.createBrowserContext({ disposeOnDetach: true })
const page = await context.newPage("about:blank")
await page.evaluate(() => document.title)

await context.close()
console.log("context closed")

await handstage.close()
console.log("handstage closed")
await browser.close()
console.log("browser closed")
await instance.close()
console.log("instance closed")

clearTimeout(hangTimer)
console.log("[repro] teardown complete — waiting for natural process exit")
