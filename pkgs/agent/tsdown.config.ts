import { defineConfig } from "tsdown"
import { tsdownBaseConfig } from "../../tsdown.config.ts"

export default defineConfig({
	...tsdownBaseConfig,
	entry: ["src/index.ts"],
})
