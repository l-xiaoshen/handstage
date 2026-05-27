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
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
	})

	const fd3 = p.stdio[3] // ReadableStream in Bun (because of "pipe")
	const fd4 = p.stdio[4] // FileSink (Writable) in Bun (because of "pipe")

	if (!fd3 || !fd4) {
		throw new Error("Failed to map Chrome pipes to Bun stdio streams")
	}

	const stdin = new WritableStream<Uint8Array>({
		write(chunk) {
			fd4.write(chunk)
			fd4.flush()
		},
		close() {
			fd4.end()
		},
		abort() {
			fd4.end()
		},
	})

	const close = async () => {
		try {
			fd4.end()
			p.kill()

			cleanupUserDataDir(userDataDir, createdTemp, lbo)
		} catch {}
	}

	return {
		stdout: fd3,
		stdin,
		close,
		pid: p.pid,
		userDataDir,
		createdTempProfile: createdTemp,
	}
}
