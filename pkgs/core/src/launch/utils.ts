import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { getChromePath } from "chrome-launcher"
// `DEFAULT_FLAGS` is intentionally not re-exported from chrome-launcher's
// package entry, so import it from the flags module directly.
import { DEFAULT_FLAGS } from "chrome-launcher/dist/flags.js"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/options"

export interface PreparedLaunchOptions {
	chromePath: string
	finalFlags: string[]
	userDataDir: string | undefined
	createdTemp: boolean
}

export function prepareChromeLaunchOptions(
	opts?: LocalBrowserLaunchOptions,
): PreparedLaunchOptions {
	const lbo = opts ?? {}
	const chromePath = lbo.executablePath || getChromePath()

	let userDataDir = lbo.userDataDir
	let createdTemp = false
	if (!userDataDir) {
		const base = path.join(os.tmpdir(), "handstage-v3")
		fs.mkdirSync(base, { recursive: true })
		userDataDir = fs.mkdtempSync(path.join(base, "profile-"))
		createdTemp = true
	}

	let baseChromeFlags: string[] = []
	const ignore = lbo.ignoreDefaultArgs
	if (ignore === true) {
		baseChromeFlags = []
	} else if (Array.isArray(ignore)) {
		baseChromeFlags = DEFAULT_FLAGS.filter(
			(f) => !ignore.some((ex) => f.includes(ex)),
		)
	} else {
		baseChromeFlags = [...DEFAULT_FLAGS]
	}

	const chromeFlags = [
		...(lbo.headless !== false ? ["--headless=new"] : []),
		...baseChromeFlags,
		"--remote-debugging-pipe",
	]

	if (lbo.devtools) chromeFlags.push("--auto-open-devtools-for-tabs")
	if (lbo.locale) chromeFlags.push(`--lang=${lbo.locale}`)
	if (lbo.viewport?.width && lbo.viewport?.height) {
		chromeFlags.push(
			`--window-size=${lbo.viewport.width},${lbo.viewport.height + 87}`,
		)
	}
	if (typeof lbo.deviceScaleFactor === "number") {
		chromeFlags.push(
			`--force-device-scale-factor=${Math.max(0.1, lbo.deviceScaleFactor)}`,
		)
	}
	if (lbo.hasTouch) chromeFlags.push("--touch-events=enabled")
	if (lbo.ignoreHTTPSErrors) chromeFlags.push("--ignore-certificate-errors")
	if (lbo.proxy?.server) chromeFlags.push(`--proxy-server=${lbo.proxy.server}`)
	if (lbo.proxy?.bypass)
		chromeFlags.push(`--proxy-bypass-list=${lbo.proxy.bypass}`)
	if (userDataDir) chromeFlags.push(`--user-data-dir=${userDataDir}`)

	if (Array.isArray(lbo.args)) chromeFlags.push(...lbo.args)

	const finalFlags = chromeFlags.filter(
		(f): f is string => typeof f === "string",
	)

	return {
		chromePath,
		finalFlags,
		userDataDir,
		createdTemp,
	}
}

export function cleanupUserDataDir(
	userDataDir: string | undefined,
	createdTemp: boolean,
	opts?: LocalBrowserLaunchOptions,
): void {
	if (createdTemp && !opts?.preserveUserDataDir && userDataDir) {
		try {
			fs.rmSync(userDataDir, { recursive: true, force: true })
		} catch {}
	}
}
