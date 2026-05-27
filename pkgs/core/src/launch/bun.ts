import type { LocalBrowserLaunchOptions } from "../v3/types/public/api"
import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import { cleanupUserDataDir, prepareChromeLaunchOptions } from "./utils"

export async function launchChromeBun(
	opts?: LocalBrowserLaunchOptions,
): Promise<LaunchedChrome> {
	const lbo = opts ?? {}
	const { chromePath, finalFlags, userDataDir, createdTemp } =
		prepareChromeLaunchOptions(lbo)

	const p = Bun.spawn([chromePath, ...finalFlags], {
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
	})

	const fd3 = p.stdio[3] // FileSink (Writable) in Bun (Chrome's read pipe)
	const fd4 = p.stdio[4] // ReadableStream in Bun (Chrome's write pipe)

	if (!fd3 || !fd4) {
		throw new Error("Failed to map Chrome pipes to Bun stdio streams")
	}

	const stdin = new WritableStream<Uint8Array>({
		write(chunk) {
			fd3.write(chunk)
			fd3.flush()
		},
		close() {
			fd3.end()
		},
		abort() {
			fd3.end()
		},
	})

	const close = async () => {
		try {
			fd3.end()
			p.kill()

			cleanupUserDataDir(userDataDir, createdTemp, lbo)
		} catch {}
	}

	return {
		stdout: fd4,
		stdin,
		close,
		pid: p.pid,
		userDataDir,
		createdTempProfile: createdTemp,
	}
}
