import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { getCurrentDirPath } from "../runtimePaths";

const here = getCurrentDirPath();
const srcDir = path.join(here, "./screenshotScripts");
const outDir = path.join(here, "./build");
const entry = path.join(srcDir, "index.ts");
const moduleOut = path.join(outDir, "screenshotScripts.mjs");

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    outfile: moduleOut,
  });

  const compiledModule = (await import(
    pathToFileURL(moduleOut).href
  )) as Record<string, unknown>;

  const entries = Object.entries(compiledModule).filter(
    ([, value]) => typeof value === "function",
  );
  const sorted = entries.sort(([a], [b]) => a.localeCompare(b));

  const scriptMap: Record<string, string> = Object.fromEntries(
    sorted.map(([name, fn]) => {
      const callable = fn as (...args: unknown[]) => unknown;
      return [name, callable.toString()];
    }),
  );

  const banner = `/*\n * AUTO-GENERATED FILE. DO NOT EDIT.\n * Update sources in lib/v3/dom/screenshotScripts and run genScreenshotScripts.ts.\n */`;

  const content = `${banner}
export const screenshotScriptSources = ${JSON.stringify(scriptMap, null, 2)} as const;
export type ScreenshotScriptName = keyof typeof screenshotScriptSources;
`;

  await writeFile(
    path.join(outDir, "screenshotScripts.generated.ts"),
    content,
  );

  await unlink(moduleOut).catch(() => {});
}

void main();
