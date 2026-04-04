import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import esbuild from "esbuild"
import { getCurrentDirPath } from "./runtimePaths"

const here = getCurrentDirPath()
const outDir = path.join(here, "./build")
const entry = path.join(here, "./locatorScripts/index.ts")
const moduleOutfile = path.join(outDir, "locatorScripts.mjs")
const bundleOutfile = path.join(outDir, "locatorScripts.bundle.js")

async function main(): Promise<void> {
	await mkdir(outDir, { recursive: true })

	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2020",
		minify: true,
		outfile: moduleOutfile,
	})

	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "es2020",
		globalName: "__handstagesLocatorScriptsFactory",
		minify: true,
		outfile: bundleOutfile,
	})

	const bundleRaw = (await readFile(bundleOutfile, "utf8")).trim()
	const bootstrap = `if (!globalThis.__handstagesLocatorScripts) { ${bundleRaw}\n  globalThis.__handstagesLocatorScripts = __handstagesLocatorScriptsFactory;\n}`

	const compiledModule = (await import(
		pathToFileURL(moduleOutfile).href
	)) as Record<string, unknown>

	const entries = Object.entries(compiledModule).filter(
		([, value]) => typeof value === "function",
	)
	const sorted = entries.sort(([a], [b]) => a.localeCompare(b))

	const scriptMap: Record<string, string> = Object.fromEntries(
		sorted.map(([name, fn]) => {
			const callable = fn as (...args: unknown[]) => unknown
			return [name, callable.toString()]
		}),
	)

	const banner = `/*\n * AUTO-GENERATED FILE. DO NOT EDIT.\n * Update sources in pkgs/dom/src/locatorScripts and run genLocatorScripts.ts.\n */`

	const globalRefs: Record<string, string> = Object.fromEntries(
		sorted.map(([name]) => [
			name,
			`globalThis.__handstagesLocatorScripts.${name}`,
		]),
	)

	const content = `${banner}\nexport const locatorScriptBootstrap = ${JSON.stringify(bootstrap)};\nexport const locatorScriptSources = ${JSON.stringify(scriptMap, null, 2)} as const;\nexport const locatorScriptGlobalRefs = ${JSON.stringify(globalRefs, null, 2)} as const;\nexport type LocatorScriptName = keyof typeof locatorScriptSources;\n`

	await writeFile(path.join(outDir, "locatorScripts.generated.ts"), content)

	await unlink(moduleOutfile).catch(() => {})
	await unlink(bundleOutfile).catch(() => {})
}

void main()
