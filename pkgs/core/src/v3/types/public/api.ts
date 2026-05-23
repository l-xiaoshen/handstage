/**
 * Local browser launch options schema (Zod).
 */
import { z } from "zod"

export const LocalBrowserLaunchOptionsSchema = z
	.object({
		args: z.array(z.string()).optional(),
		executablePath: z.string().optional(),
		port: z.number().optional(),
		userDataDir: z.string().optional(),
		preserveUserDataDir: z.boolean().optional(),
		headless: z.boolean().optional(),
		devtools: z.boolean().optional(),
		chromiumSandbox: z.boolean().optional(),
		ignoreDefaultArgs: z.union([z.boolean(), z.array(z.string())]).optional(),
		proxy: z
			.object({
				server: z.string(),
				bypass: z.string().optional(),
				username: z.string().optional(),
				password: z.string().optional(),
			})
			.optional(),
		locale: z.string().optional(),
		viewport: z.object({ width: z.number(), height: z.number() }).optional(),
		deviceScaleFactor: z.number().optional(),
		hasTouch: z.boolean().optional(),
		ignoreHTTPSErrors: z.boolean().optional(),
		cdpUrl: z.string().optional(),
		cdpHeaders: z.record(z.string(), z.string()).optional(),
		connectTimeoutMs: z.number().optional(),
		downloadsPath: z.string().optional(),
		acceptDownloads: z.boolean().optional(),
	})
	.strict()
	.meta({ id: "LocalBrowserLaunchOptions" })
