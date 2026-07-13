/// <reference types="node" />
import { type ChildProcess, spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { Readable, Writable } from "node:stream"
import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/options"
import {
	cleanupUserDataDir,
	performBrowserProcessCleanup,
	prepareChromeLaunchOptions,
} from "./utils"

export async function launchChromeNode(
	opts?: LocalBrowserLaunchOptions,
): Promise<LaunchedChrome> {
	const lbo = opts ?? {}
	const { chromePath, finalFlags, userDataDir, createdTemp } =
		prepareChromeLaunchOptions(lbo)
	try {
		accessSync(chromePath, constants.X_OK)
	} catch (error) {
		cleanupUserDataDir(userDataDir, createdTemp, lbo)
		throw error
	}

	const p: ChildProcess = spawn(chromePath, finalFlags, {
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
	})
	p.once("error", () => {
		cleanupUserDataDir(userDataDir, createdTemp, lbo)
	})
	const exited = new Promise<void>((resolve) => {
		if (p.exitCode !== null || p.signalCode !== null) resolve()
		else p.once("exit", () => resolve())
	})

	const fd3 = p.stdio[3] // Chrome's read pipe (our WritableStream)
	const fd4 = p.stdio[4] // Chrome's write pipe (our ReadableStream)

	if (!(fd3 instanceof Writable) || !(fd4 instanceof Readable)) {
		await performBrowserProcessCleanup(
			(signal) => p.kill(signal),
			exited,
			userDataDir,
			createdTemp,
			lbo,
		)
		throw new Error("Failed to map Chrome pipes to stdio")
	}

	let cleanupStdout = (): void => {}
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			let settled = false
			const cleanup = () => {
				fd4.off("data", onData)
				fd4.off("end", onEnd)
				fd4.off("close", onClose)
				fd4.off("error", onError)
			}
			const finish = () => {
				if (settled) return
				settled = true
				cleanup()
				try {
					controller.close()
				} catch {}
			}
			const onData = (chunk: Buffer) => {
				// A late chunk can race stream cancellation; enqueue would throw.
				try {
					controller.enqueue(new Uint8Array(chunk))
				} catch {
					cleanup()
					fd4.destroy()
					return
				}
				// Pause when the consumer falls behind; pull() resumes.
				if ((controller.desiredSize ?? 1) <= 0) {
					fd4.pause()
				}
			}
			const onEnd = () => finish()
			const onClose = () => finish()
			const onError = (err: Error) => {
				if (settled) return
				settled = true
				cleanup()
				try {
					controller.error(err)
				} catch {}
			}
			cleanupStdout = cleanup
			fd4.on("data", onData)
			fd4.on("end", onEnd)
			fd4.on("close", onClose)
			fd4.on("error", onError)
		},
		pull() {
			fd4.resume()
		},
		cancel() {
			cleanupStdout()
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
			if (err === undefined) fd3.destroy()
			else fd3.destroy(err instanceof Error ? err : new Error(String(err)))
		},
	})

	let closePromise: Promise<void> | null = null
	const close = (): Promise<void> => {
		if (closePromise) return closePromise
		closePromise = (async () => {
			fd3.destroy()
			fd4.destroy()

			await performBrowserProcessCleanup(
				(signal) => p.kill(signal),
				exited,
				userDataDir,
				createdTemp,
				lbo,
			)
		})()
		return closePromise
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
