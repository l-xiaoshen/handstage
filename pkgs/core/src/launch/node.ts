/// <reference types="node" />
import { type ChildProcess, spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/options"
import {
	performBrowserProcessCleanup,
	prepareChromeLaunchOptions,
} from "./utils"

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
				// A late chunk can race stream cancellation; enqueue would throw.
				try {
					controller.enqueue(new Uint8Array(chunk))
				} catch {
					fd4.destroy()
					return
				}
				// Pause when the consumer falls behind; pull() resumes.
				if ((controller.desiredSize ?? 1) <= 0) {
					fd4.pause()
				}
			})
			fd4.on("end", () => {
				try {
					controller.close()
				} catch {}
			})
			fd4.on("error", (err) => {
				try {
					controller.error(err)
				} catch {}
			})
		},
		pull() {
			fd4.resume()
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

			const exited = new Promise<void>((resolve) => {
				if (p.exitCode !== null || p.signalCode !== null) resolve()
				else p.once("exit", resolve)
			})

			await performBrowserProcessCleanup(
				(signal) => p.kill(signal),
				exited,
				userDataDir,
				createdTemp,
				lbo,
			)
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
