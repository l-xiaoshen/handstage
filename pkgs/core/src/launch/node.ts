import { spawn, type ChildProcess } from "node:child_process"
import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { getChromePath, DEFAULT_FLAGS } from "chrome-launcher"
import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/api"

export async function launchChromeNode(
	opts?: LocalBrowserLaunchOptions,
): Promise<LaunchedChrome> {
	const lbo = opts ?? {}
	const chromePath = lbo.executablePath || getChromePath()

	let userDataDir = lbo.userDataDir
	if (!userDataDir) {
		const base = path.join(os.tmpdir(), "handstage-v3")
		fs.mkdirSync(base, { recursive: true })
		userDataDir = fs.mkdtempSync(path.join(base, "profile-"))
	}

	const chromeFlags = [
		...(lbo.headless !== false ? ["--headless=new"] : []),
		...DEFAULT_FLAGS,
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

	// Filter out undefined and deduplicate if necessary.
	const finalFlags = chromeFlags.filter((f): f is string => typeof f === "string")

	const p: ChildProcess = spawn(chromePath, finalFlags, {
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
	})

	const fd3 = p.stdio[3]
	const fd4 = p.stdio[4]

	if (!fd3 || !fd4) {
		throw new Error("Failed to map Chrome pipes to stdio")
	}

	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			fd3.on("data", (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk))
			})
			fd3.on("end", () => {
				controller.close()
			})
			fd3.on("error", (err) => {
				controller.error(err)
			})
		},
		cancel() {
			fd3.destroy()
		},
	})

	const stdin = new WritableStream<Uint8Array>({
		write(chunk, controller) {
			return new Promise((resolve, reject) => {
				fd4.write(chunk, (err) => {
					if (err) {
						controller.error(err)
						reject(err)
					} else {
						resolve()
					}
				})
			})
		},
		close() {
			return new Promise((resolve) => {
				fd4.end(resolve)
			})
		},
		abort(err) {
			fd4.destroy(typeof err === "error" ? err : new Error(String(err)))
		},
	})

	const close = async () => {
		try {
			fd3.destroy()
			fd4.destroy()
			p.kill()
			
			// Optional cleanup if temp dir was created internally and should be removed
			if (!lbo.preserveUserDataDir && !opts?.userDataDir && userDataDir) {
				try {
					fs.rmSync(userDataDir, { recursive: true, force: true })
				} catch {}
			}
		} catch {}
	}

	return {
		stdout,
		stdin,
		close,
	}
}
