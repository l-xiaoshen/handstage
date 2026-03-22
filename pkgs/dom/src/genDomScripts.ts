/**
 * Build the v3 DOM script into a single JS file and then export its contents
 * as a string constant (`v3ScriptContent`) for CDP injection (document-start).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import esbuild from "esbuild"
import { getCurrentDirPath } from "./runtimePaths"

const here = getCurrentDirPath()
const outDir = path.join(here, "./build")

async function main(): Promise<void> {
	await mkdir(outDir, { recursive: true })

	await esbuild.build({
		entryPoints: [path.join(here, "piercer.entry.ts")],
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "es2020",
		minify: true,
		legalComments: "none",
		outfile: path.join(outDir, "v3-index.js"),
	})

	const script = await readFile(path.join(outDir, "v3-index.js"), "utf8")
	const content = `export const v3ScriptContent = ${JSON.stringify(script)};`

	await writeFile(path.join(outDir, "scriptV3Content.ts"), content)

	await esbuild.build({
		entryPoints: [path.join(here, "rerenderMissingShadows.entry.ts")],
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "es2020",
		minify: true,
		legalComments: "none",
		outfile: path.join(outDir, "rerender-index.js"),
	})

	const rerenderScript = await readFile(
		path.join(outDir, "rerender-index.js"),
		"utf8",
	)
	const rerenderContent = `export const reRenderScriptContent = ${JSON.stringify(
		rerenderScript,
	)};`
	await writeFile(
		path.join(outDir, "reRenderScriptContent.ts"),
		rerenderContent,
	)
}

void main()
