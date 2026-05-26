import type { LaunchedChrome } from "../v3/types/public/launchedChrome"
import type { LocalBrowserLaunchOptions } from "../v3/types/public/api"
import { prepareChromeLaunchOptions, cleanupUserDataDir } from "./utils"

export async function launchChromeBun(
	opts?: LocalBrowserLaunchOptions,
): Promise<LaunchedChrome> {
	const lbo = opts ?? {}
	const { chromePath, finalFlags, userDataDir } = prepareChromeLaunchOptions(lbo)

	const p = Bun.spawn([chromePath, ...finalFlags], {
		stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
	})

	const fd3 = p.stdio[3] // ReadableStream in Bun
	const fd4 = p.stdio[4] // WritableStream in Bun

	if (!fd3 || !fd4) {
		throw new Error("Failed to map Chrome pipes to Bun stdio streams")
	}

	const close = async () => {
		try {
			p.kill()
			
			cleanupUserDataDir(userDataDir, lbo)
		} catch {}
	}

	return {
		stdout: fd3 as ReadableStream<Uint8Array>,
		stdin: fd4 as WritableStream<Uint8Array>,
		close,
	}
}
