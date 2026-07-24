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

	let p: ChildProcess
	try {
		p = spawn(chromePath, finalFlags, {
			stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		})
	} catch (error) {
		cleanupUserDataDir(userDataDir, createdTemp, lbo)
		throw error
	}

	// Bun's node:child_process shim sets pid without emitting Node's spawn event.
	let startupSettled = typeof p.pid === "number" && p.pid > 0
	let resolveStartup!: () => void
	let rejectStartup!: (error: Error) => void
	const startup = new Promise<void>((resolve, reject) => {
		resolveStartup = resolve
		rejectStartup = reject
		if (startupSettled) {
			resolve()
		}
	})
	const onSpawn = () => {
		if (startupSettled) {
			return
		}
		startupSettled = true
		resolveStartup()
	}
	const onProcessError = (error: Error) => {
		if (startupSettled) {
			return
		}
		startupSettled = true
		p.off("spawn", onSpawn)
		rejectStartup(error)
	}
	p.once("spawn", onSpawn)
	p.on("error", onProcessError)
	const exited = new Promise<void>((resolve) => {
		const onClose = () => {
			p.off("spawn", onSpawn)
			p.off("error", onProcessError)
			resolve()
		}
		if (p.exitCode !== null || p.signalCode !== null) {
			onClose()
		} else {
			p.once("close", onClose)
		}
	})
	try {
		await startup
	} catch (error) {
		await exited
		cleanupUserDataDir(userDataDir, createdTemp, lbo)
		throw error
	}

	const fd3 = p.stdio[3] // Chrome's read pipe (our WritableStream)
	const fd4 = p.stdio[4] // Chrome's write pipe (our ReadableStream)

	if (!(fd3 instanceof Writable) || !(fd4 instanceof Readable)) {
		await performBrowserProcessCleanup(
			(signal) => p.kill(signal),
			exited,
			userDataDir,
			createdTemp,
			lbo,
			() => p.unref(),
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
				if (settled) {
					return
				}
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
				if (settled) {
					return
				}
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

	let stdinController: WritableStreamDefaultController | null = null
	let stdinError: Error | null = null
	const onStdinError = (error: Error) => {
		stdinError = error
		try {
			stdinController?.error(error)
		} catch {}
	}
	fd3.on("error", onStdinError)
	fd3.once("close", () => {
		fd3.off("error", onStdinError)
		stdinController = null
	})

	const stdin = new WritableStream<Uint8Array>({
		start(controller) {
			stdinController = controller
		},
		write(chunk, controller) {
			if (stdinError) {
				controller.error(stdinError)
				return Promise.reject(stdinError)
			}
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
		abort() {
			fd3.destroy()
		},
	})

	let closePromise: Promise<void> | null = null
	const close = async (): Promise<void> => {
		if (closePromise) {
			return closePromise
		}
		const operation = (async () => {
			fd3.destroy()
			fd4.destroy()

			await performBrowserProcessCleanup(
				(signal) => p.kill(signal),
				exited,
				userDataDir,
				createdTemp,
				lbo,
				() => p.unref(),
			)
		})()
		closePromise = operation
		try {
			await operation
		} catch (error) {
			if (closePromise === operation) {
				closePromise = null
			}
			throw error
		}
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
