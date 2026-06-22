import { defineConfig, type UserConfig } from "tsdown"

export const tsdownBaseConfig = {
	format: "esm",
	dts: false,
	unbundle: true,
	clean: true,
	fixedExtension: false,
	outExtensions: () => ({
		js: ".js",
		dts: ".d.ts",
	}),
	deps: {
		neverBundle: ["bun"],
		skipNodeModulesBundle: true,
	},
} satisfies UserConfig

export default defineConfig(tsdownBaseConfig)
