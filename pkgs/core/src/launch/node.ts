import { type ChildProcess, spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/options"
import { cleanupUserDataDir, prepareChromeLaunchOptions } from "./utils"

const CHROME_EXIT_TIMEOUT_MS = 5000

function waitForExit(p: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve(true)
	return Promise.race([
		new Promise<boolean>((resolve) => {
			p.once("exit", () => resolve(true))
		}),
		new Promise<boolean>((resolve) =>
			setTimeout(() => resolve(false), timeoutMs),
		),
	])
}

export async function launchChromeNode(
	opts?: LocalBrowserLaunchOptions,
): Promise<LaunchedChrome> {
	const lbo = opts ?? {}
	const { chromePath, finalFlags, userDataDir, createdTemp } =
		prepareChromeLaunchOptions(lbo)

	const p: ChildProcess = spawn(chromePath, finalFlags, {
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
	})

	const fd3 = p.stdio[3] // Chrome's read pipe (our WritableStream)
	const fd4 = p.stdio[4] // Chrome's write pipe (our ReadableStream)

	if (!(fd3 instanceof Writable) || !(fd4 instanceof Readable)) {
		throw new Error("Failed to map Chrome pipes to stdio")
	}

	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			fd4.on("data", (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk))
			})
			fd4.on("end", () => {
				controller.close()
			})
			fd4.on("error", (err) => {
				controller.error(err)
			})
		},
		cancel() {
			fd4.destroy()
		},
	})

	const stdin = new WritableStream<Uint8Array>({
		write(chunk, controller) {
			return new Promise((resolve, reject) => {
				fd3.write(chunk, (err) => {
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
				fd3.end(resolve)
			})
		},
		abort(err) {
			fd3.destroy(err instanceof Error ? err : new Error(String(err)))
		},
	})

	const close = async () => {
		try {
			fd3.destroy()
			fd4.destroy()
			p.kill()
			if (!(await waitForExit(p, CHROME_EXIT_TIMEOUT_MS))) {
				p.kill("SIGKILL")
				await waitForExit(p, CHROME_EXIT_TIMEOUT_MS)
			}

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
