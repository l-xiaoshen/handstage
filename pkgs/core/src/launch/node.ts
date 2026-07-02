/// <reference types="node" />
import { type ChildProcess, spawn } from "node:child_process"
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

	let p: ChildProcess | undefined
	try {
		p = spawn(chromePath, finalFlags, {
			stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		})
		const child = p

		// `spawn` emits 'error' asynchronously (ENOENT/EACCES/…). Without a
		// listener Node rethrows it as an uncaught exception that crashes the
		// host. Keep a persistent no-op listener so late errors never crash the
		// process; the pipe streams surface I/O failures to connectLocal.
		child.on("error", () => {})

		// Wait for the process to actually spawn (or fail) before returning, so a
		// bad executablePath rejects cleanly here instead of surfacing later as an
		// unusable browser. Exactly one of 'spawn' / 'error' fires.
		await new Promise<void>((resolve, reject) => {
			let settled = false
			child.once("spawn", () => {
				if (!settled) {
					settled = true
					resolve()
				}
			})
			child.once("error", (err) => {
				if (!settled) {
					settled = true
					reject(err instanceof Error ? err : new Error(String(err)))
				}
			})
		})

		const fd3 = child.stdio[3] // Chrome's read pipe (our WritableStream)
		const fd4 = child.stdio[4] // Chrome's write pipe (our ReadableStream)

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

		let closed = false
		const close = async () => {
			// Idempotent: repeated close() must not re-run teardown or add another
			// 'exit' listener.
			if (closed) return
			closed = true
			try {
				fd3.destroy()
				fd4.destroy()

				const exited = new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) resolve()
					else child.once("exit", resolve)
				})

				await performBrowserProcessCleanup(
					(signal) => child.kill(signal),
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
			pid: child.pid,
			userDataDir,
			createdTempProfile: createdTemp,
		}
	} catch (err) {
		// Launch setup failed after we created a temp profile and possibly
		// spawned the process. Kill any spawned process and remove the temp
		// profile dir so we neither orphan a process nor leak the directory.
		if (p) {
			try {
				p.kill("SIGKILL")
			} catch {}
		}
		cleanupUserDataDir(userDataDir, createdTemp, lbo)
		throw err
	}
}
