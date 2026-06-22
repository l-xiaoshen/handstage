import { defineConfig } from "tsdown"
import { tsdownBaseConfig } from "../../tsdown.config.ts"

export default defineConfig({
	...tsdownBaseConfig,
	entry: [
		"src/index.ts",
		"src/launch/node.ts",
		"src/launch/bun.ts",
		"src/v3/connect/index.ts",
		"src/v3/connect/ws.ts",
		"src/v3/connect/local.ts",
		"src/v3/connect/transport.ts",
		"src/v3/connect/session.ts",
		"src/v3/connect/connection.ts",
	],
})
