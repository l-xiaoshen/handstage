import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { getCurrentDirPath } from "../runtimePaths";

const here = getCurrentDirPath();
const srcDir = path.join(here, "./a11yScripts");
const outDir = path.join(here, "./build");
const entry = path.join(srcDir, "index.ts");
const moduleOut = path.join(outDir, "a11yScripts.mjs");
const bundleOut = path.join(outDir, "a11yScripts.bundle.js");

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

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    globalName: "__stagehandA11yScriptsFactory",
    minify: true,
    outfile: bundleOut,
  });

  const bundleRaw = (await readFile(bundleOut, "utf8")).trim();
  const bootstrap = `if (!globalThis.__stagehandA11yScripts) { ${bundleRaw}\n  globalThis.__stagehandA11yScripts = __stagehandA11yScriptsFactory;\n}`;

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

  const banner = `/*\n * AUTO-GENERATED FILE. DO NOT EDIT.\n * Update sources in lib/v3/dom/a11yScripts and run genA11yScripts.ts.\n */`;

  const globalRefs: Record<string, string> = Object.fromEntries(
    sorted.map(([name]) => [name, `globalThis.__stagehandA11yScripts.${name}`]),
  );

  const content = `${banner}
export const a11yScriptBootstrap = ${JSON.stringify(bootstrap)};
export const a11yScriptSources = ${JSON.stringify(scriptMap, null, 2)} as const;
export const a11yScriptGlobalRefs = ${JSON.stringify(globalRefs, null, 2)} as const;
export type A11yScriptName = keyof typeof a11yScriptSources;
`;

  await writeFile(path.join(outDir, "a11yScripts.generated.ts"), content);

  await unlink(moduleOut).catch(() => {});
  await unlink(bundleOut).catch(() => {});
}

void main();
