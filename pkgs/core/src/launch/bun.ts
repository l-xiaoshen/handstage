/// <reference types="bun" />
import Bun from "bun"
import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/options"
import {
	cleanupUserDataDir,
	performBrowserProcessCleanup,
	prepareChromeLaunchOptions,
} from "./utils"

export async function launchChromeBun(
	opts?: LocalBrowserLaunchOptions,
): Promise<LaunchedChrome> {
	const lbo = opts ?? {}
	const { chromePath, finalFlags, userDataDir, createdTemp } =
		prepareChromeLaunchOptions(lbo)

	// `Bun.spawn` throws synchronously if the binary can't be launched, and the
	// stdio-mapping check below also throws — both AFTER prepareChromeLaunchOptions
	// created the temp profile. Wrap so we always kill any spawned process and
	// remove the temp dir on failure instead of leaking them.
	let p: Bun.Subprocess | undefined
	try {
		p = Bun.spawn([chromePath, ...finalFlags], {
			stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		})
		const child = p

		const fd3 = child.stdio[3] // Chrome's read pipe
		const fd4 = child.stdio[4] // Chrome's write pipe

		if (typeof fd3 !== "number" || typeof fd4 !== "number") {
			throw new Error("Failed to map Chrome pipes to Bun stdio streams")
		}

		const fd3Writer = Bun.file(fd3).writer()
		const fd4Reader = Bun.file(fd4).stream()

		const stdin = new WritableStream<Uint8Array>({
			write(chunk) {
				fd3Writer.write(chunk)
				fd3Writer.flush()
			},
			close() {
				fd3Writer.end()
			},
			abort() {
				fd3Writer.end()
			},
		})

		let closed = false
		const close = async () => {
			// Idempotent: guard against repeated close().
			if (closed) return
			closed = true
			try {
				fd3Writer.end()
				await performBrowserProcessCleanup(
					(signal) => child.kill(signal),
					child.exited,
					userDataDir,
					createdTemp,
					lbo,
				)
			} catch {}
		}

		return {
			stdout: fd4Reader,
			stdin,
			close,
			pid: child.pid,
			userDataDir,
			createdTempProfile: createdTemp,
		}
	} catch (err) {
		if (p) {
			try {
				p.kill()
			} catch {}
		}
		cleanupUserDataDir(userDataDir, createdTemp, lbo)
		throw err
	}
}
