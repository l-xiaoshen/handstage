/// <reference types="bun" />
import Bun from "bun"
import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/options"
import {
	performBrowserProcessCleanup,
	prepareChromeLaunchOptions,
} from "./utils"

export async function launchChromeBun(
	opts?: LocalBrowserLaunchOptions,
): Promise<LaunchedChrome> {
	const lbo = opts ?? {}
	const { chromePath, finalFlags, userDataDir, createdTemp } =
		prepareChromeLaunchOptions(lbo)

	const p = Bun.spawn([chromePath, ...finalFlags], {
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
	})

	const fd3 = p.stdio[3] // Chrome's read pipe
	const fd4 = p.stdio[4] // Chrome's write pipe

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

	const close = async () => {
		try {
			fd3Writer.end()
			await performBrowserProcessCleanup(
				(signal) => p.kill(signal),
				p.exited,
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
		pid: p.pid,
		userDataDir,
		createdTempProfile: createdTemp,
	}
}
