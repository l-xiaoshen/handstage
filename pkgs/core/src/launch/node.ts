import { type ChildProcess, spawn } from "node:child_process"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/api"
import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import { cleanupUserDataDir, prepareChromeLaunchOptions } from "./utils"

export async function launchChromeNode(
	opts?: LocalBrowserLaunchOptions,
): Promise<LaunchedChrome> {
	const lbo = opts ?? {}
	const { chromePath, finalFlags, userDataDir, createdTemp } =
		prepareChromeLaunchOptions(lbo)

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
			fd4.destroy(err instanceof Error ? err : new Error(String(err)))
		},
	})

	const close = async () => {
		try {
			fd3.destroy()
			fd4.destroy()
			p.kill()

			cleanupUserDataDir(userDataDir, createdTemp, lbo)
		} catch {}
	}

	return {
		stdout,
		stdin,
		close,
		pid: p.pid,
		userDataDir,
		createdTempProfile: createdTemp,
	}
}
