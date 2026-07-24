/// <reference lib="dom" />

import { screenshotScriptSources } from "@handstage/dom/build/screenshotScripts.generated"
import type { Protocol } from "devtools-protocol"
import type {
	ScreenshotClip,
	ScreenshotScaleOption,
} from "../types/public/screenshotTypes"
import { HandstageInvalidArgumentError } from "../types/public/sdkErrors"
import {
	type CDPSessionLike,
	sendCDPWithSignal,
	sendCDPWithSignalAndLateResult,
} from "./cdp"
import type { Frame } from "./frame"
import type { Locator } from "./locator"
import type { Page } from "./page"
import {
	releaseDiscardedEvaluationHandles,
	releaseObjectGroup,
	releaseObjectIds,
} from "./runtimeObjectUtils"
import {
	rollbackScreenshotCleanup,
	type ScreenshotCleanup,
} from "./screenshotCleanup"

export function collectFramesForScreenshot(page: Page): Frame[] {
	const seen = new Map<string, Frame>()
	const main = page.mainFrame()
	seen.set(main.frameId, main)
	for (const frame of page.frames()) {
		seen.set(frame.frameId, frame)
	}
	return Array.from(seen.values())
}

export function normalizeScreenshotClip(clip: ScreenshotClip): ScreenshotClip {
	const x = Number(clip.x)
	const y = Number(clip.y)
	const width = Number(clip.width)
	const height = Number(clip.height)

	for (const [key, value] of Object.entries({ x, y, width, height })) {
		if (!Number.isFinite(value)) {
			throw new HandstageInvalidArgumentError(
				`screenshot: clip.${key} must be a finite number`,
			)
		}
	}

	if (width <= 0 || height <= 0) {
		throw new HandstageInvalidArgumentError(
			"screenshot: clip width/height must be positive",
		)
	}

	return { x, y, width, height }
}

export async function computeScreenshotScale(
	page: Page,
	mode: ScreenshotScaleOption,
	signal?: AbortSignal,
): Promise<number | undefined> {
	if (mode !== "css") {
		return undefined
	}
	try {
		const frame = page.mainFrame()
		const dpr = await frame
			.evaluate(
				() => {
					const ratio = Number(window.devicePixelRatio || 1)
					return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
				},
				undefined,
				signal,
			)
			.catch((error) => {
				if (signal?.aborted) {
					throw error
				}
				return 1
			})
		const safeRatio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
		return Math.min(2, Math.max(0.1, 1 / safeRatio))
	} catch (error) {
		if (signal?.aborted) {
			throw error
		}
		return 1
	}
}

export async function setTransparentBackground(
	session: CDPSessionLike,
	signal?: AbortSignal,
): Promise<ScreenshotCleanup> {
	const cleanup = async (cleanupSignal?: AbortSignal) => {
		try {
			const command = cleanupSignal
				? sendCDPWithSignal(
						session,
						"Emulation.setDefaultBackgroundColorOverride",
						cleanupSignal,
						{},
					)
				: session.send("Emulation.setDefaultBackgroundColorOverride", {})
			await command
		} catch {}
	}
	try {
		const params = { color: { r: 0, g: 0, b: 0, a: 0 } }
		if (signal) {
			await sendCDPWithSignal(
				session,
				"Emulation.setDefaultBackgroundColorOverride",
				signal,
				params,
			)
		} else {
			await session
				.send("Emulation.setDefaultBackgroundColorOverride", params)
				.catch(() => {})
		}
		return cleanup
	} catch (error) {
		await rollbackScreenshotCleanup(cleanup, signal)
		if (signal?.aborted) {
			throw error
		}
		return cleanup
	}
}

export async function applyStyleToFrames(
	frames: Frame[],
	css: string,
	label: string,
	signal?: AbortSignal,
): Promise<ScreenshotCleanup> {
	const trimmed = css.trim()
	if (!trimmed) {
		return async () => {}
	}
	const token = `__v3_style_${label}_${Date.now()}_${Math.random()
		.toString(36)
		.slice(2)}`

	const cleanup = async (cleanupSignal?: AbortSignal) => {
		await Promise.all(
			frames.map((frame) =>
				frame
					.evaluateForCleanup(
						(token) => {
							try {
								const doc = document
								if (!doc) {
									return
								}
								const nodes = doc.querySelectorAll(
									`[data-handstage-style="${token}"]`,
								)
								for (const node of nodes) {
									node.remove()
								}
							} catch {}
						},
						token,
						cleanupSignal,
					)
					.catch(() => {}),
			),
		)
	}

	try {
		await Promise.all(
			frames.map(async (frame) => {
				try {
					await frame.evaluate(
						({ css, token }) => {
							try {
								const doc = document
								if (!doc) {
									return
								}
								const style = doc.createElement("style")
								style.setAttribute("data-handstage-style", token)
								style.textContent = css
								const parent = doc.head || doc.documentElement || doc.body
								parent?.appendChild(style)
							} catch {}
						},
						{ css: trimmed, token },
						signal,
					)
				} catch (error) {
					if (signal?.aborted) {
						throw error
					}
				}
			}),
		)
		return cleanup
	} catch (error) {
		await rollbackScreenshotCleanup(cleanup, signal)
		if (signal?.aborted) {
			throw error
		}
		return cleanup
	}
}

export async function disableAnimations(
	frames: Frame[],
	signal?: AbortSignal,
): Promise<ScreenshotCleanup> {
	const css = `
*,
*::before,
*::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  animation-play-state: paused !important;
  transition-property: none !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}`

	const cleanup = await applyStyleToFrames(frames, css, "animations", signal)

	try {
		await Promise.all(
			frames.map(async (frame) => {
				try {
					await frame.evaluate(
						() => {
							try {
								const animations =
									typeof document.getAnimations === "function"
										? document.getAnimations()
										: []
								for (const animation of animations) {
									try {
										const details = animation.effect?.getComputedTiming?.()
										if (details && details.iterations !== Infinity) {
											animation.finish?.()
										} else {
											animation.cancel?.()
										}
									} catch {
										animation.cancel?.()
									}
								}
							} catch {}
						},
						undefined,
						signal,
					)
				} catch (error) {
					if (signal?.aborted) {
						throw error
					}
				}
			}),
		)
	} catch (error) {
		await rollbackScreenshotCleanup(cleanup, signal)
		if (signal?.aborted) {
			throw error
		}
	}

	return cleanup
}

export async function hideCaret(
	frames: Frame[],
	signal?: AbortSignal,
): Promise<ScreenshotCleanup> {
	const css = `
input,
textarea,
[contenteditable],
[contenteditable=""],
[contenteditable="true"],
[contenteditable="plaintext-only"],
*:focus {
  caret-color: transparent !important;
}`

	return applyStyleToFrames(frames, css, "caret", signal)
}

export async function applyMaskOverlays(
	locators: Locator[],
	color: string,
	signal?: AbortSignal,
): Promise<ScreenshotCleanup> {
	type MaskRectSpec = ScreenshotClip & { rootToken?: string | null }
	const rectsByFrame = new Map<
		Frame,
		{ rects: MaskRectSpec[]; rootTokens: Set<string> }
	>()

	const token = `__v3_mask_${Date.now()}_${Math.random().toString(36).slice(2)}`
	const cleanupFrames = [
		...new Set(locators.map((locator) => locator.getFrame())),
	]
	const cleanup = async (cleanupSignal?: AbortSignal) => {
		await Promise.all(
			cleanupFrames.map((frame) =>
				frame
					.evaluateForCleanup(
						(token) => {
							try {
								const doc = document
								if (!doc) {
									return
								}
								for (const node of doc.querySelectorAll(
									`[data-handstage-mask="${token}"]`,
								)) {
									node.remove()
								}
								for (const node of doc.querySelectorAll(
									`[data-handstage-mask-root^="${token}_root_"]`,
								)) {
									if (!(node instanceof HTMLElement)) {
										continue
									}
									const root = node
									const previous = root.getAttribute(
										"data-handstage-mask-root-pos",
									)
									if (previous !== null) {
										root.style.position = previous
										root.removeAttribute("data-handstage-mask-root-pos")
									}
									root.removeAttribute("data-handstage-mask-root")
								}
							} catch {}
						},
						token,
						cleanupSignal,
					)
					.catch(() => {}),
			),
		)
	}

	try {
		for (const locator of locators) {
			signal?.throwIfAborted()
			try {
				const info = await resolveMaskRects(locator, token, signal)
				if (!info) {
					continue
				}
				const entry = rectsByFrame.get(info.frame) ?? {
					rects: [],
					rootTokens: new Set<string>(),
				}
				entry.rects.push(...info.rects)
				for (const rect of info.rects) {
					if (rect.rootToken) {
						entry.rootTokens.add(rect.rootToken)
					}
				}
				rectsByFrame.set(info.frame, entry)
			} catch (error) {
				if (signal?.aborted) {
					throw error
				}
			}
		}
		signal?.throwIfAborted()
	} catch (error) {
		await rollbackScreenshotCleanup(cleanup, signal)
		throw error
	}

	if (rectsByFrame.size === 0) {
		await rollbackScreenshotCleanup(cleanup, signal)
		return async () => {}
	}

	try {
		await Promise.all(
			Array.from(rectsByFrame.entries()).map(async ([frame, { rects }]) => {
				try {
					await frame.evaluate(
						({ rects, color, token }) => {
							try {
								const doc = document
								if (!doc) {
									return
								}
								for (const rect of rects) {
									const defaultRoot = doc.documentElement || doc.body
									if (!defaultRoot) {
										return
									}
									const root = rect.rootToken
										? doc.querySelector(
												`[data-handstage-mask-root="${rect.rootToken}"]`,
											) || defaultRoot
										: defaultRoot
									if (!root) {
										continue
									}
									if (rect.rootToken) {
										try {
											const style = window.getComputedStyle(root)
											if (style && style.position === "static") {
												if (!(root instanceof HTMLElement)) {
													continue
												}
												const rootEl = root
												if (
													!rootEl.hasAttribute("data-handstage-mask-root-pos")
												) {
													rootEl.setAttribute(
														"data-handstage-mask-root-pos",
														rootEl.style.position || "",
													)
												}
												rootEl.style.position = "relative"
											}
										} catch {}
									}
									const el = doc.createElement("div")
									el.setAttribute("data-handstage-mask", token)
									el.style.position = "absolute"
									el.style.left = `${rect.x}px`
									el.style.top = `${rect.y}px`
									el.style.width = `${rect.width}px`
									el.style.height = `${rect.height}px`
									el.style.backgroundColor = color
									el.style.pointerEvents = "none"
									el.style.zIndex = "2147483647"
									el.style.opacity = "1"
									el.style.mixBlendMode = "normal"
									root.appendChild(el)
								}
							} catch {}
						},
						{ rects, color, token },
						signal,
					)
				} catch (error) {
					if (signal?.aborted) {
						throw error
					}
				}
			}),
		)
		signal?.throwIfAborted()
		return cleanup
	} catch (error) {
		await rollbackScreenshotCleanup(cleanup, signal)
		throw error
	}
}

async function resolveMaskRects(
	locator: Locator,
	maskToken: string,
	signal?: AbortSignal,
): Promise<{
	frame: Frame
	rects: Array<ScreenshotClip & { rootToken?: string | null }>
} | null> {
	const frame = locator.getFrame()
	const session = frame.session
	try {
		const resolved: Array<{
			objectId: Protocol.Runtime.RemoteObjectId
			nodeId: Protocol.DOM.NodeId | null
			objectGroup?: string
		}> = await locator.resolveNodesForMask(signal)
		try {
			const rects = (
				await Promise.all(
					resolved.map(async ({ objectId, objectGroup }) => {
						try {
							return await resolveMaskRectForObject(
								session,
								objectId,
								maskToken,
								signal,
								objectGroup,
							)
						} catch (error) {
							if (signal?.aborted) {
								throw error
							}
							return null
						}
					}),
				)
			).filter((rect): rect is ScreenshotClip & { rootToken?: string | null } =>
				Boolean(rect),
			)
			if (!rects.length) {
				return null
			}
			return { frame, rects }
		} finally {
			const objectGroups = [
				...new Set(resolved.map(({ objectGroup }) => objectGroup)),
			].filter((group): group is string => Boolean(group))
			const cleanup = Promise.allSettled([
				releaseObjectIds(
					session,
					resolved.map(({ objectId }) => objectId),
				),
				...objectGroups.map((group) => releaseObjectGroup(session, group)),
			])
			if (signal?.aborted) {
				void cleanup
			} else {
				await cleanup
			}
		}
	} catch (error) {
		if (signal?.aborted) {
			throw error
		}
		return null
	}
}

async function resolveMaskRectForObject(
	session: CDPSessionLike,
	objectId: Protocol.Runtime.RemoteObjectId,
	maskToken: string,
	signal?: AbortSignal,
	objectGroup?: string,
): Promise<(ScreenshotClip & { rootToken?: string | null }) | null> {
	const params = {
		objectId,
		functionDeclaration: screenshotScriptSources.resolveMaskRect,
		arguments: [{ value: maskToken }],
		returnByValue: true,
		objectGroup,
	}
	const result = signal
		? await sendCDPWithSignalAndLateResult(
				session,
				"Runtime.callFunctionOn",
				signal,
				() =>
					objectGroup ? releaseObjectGroup(session, objectGroup) : undefined,
				params,
			)
		: await session.send("Runtime.callFunctionOn", params)

	const failed = Boolean(result.exceptionDetails)
	const rect = failed
		? null
		: (result.result.value as
				| (ScreenshotClip & { rootToken?: string | null })
				| null)
	await releaseDiscardedEvaluationHandles(session, result)

	if (failed) {
		return null
	}

	if (!rect) {
		return null
	}

	const { x, y, width, height } = rect
	if (
		!Number.isFinite(x) ||
		!Number.isFinite(y) ||
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return null
	}

	return {
		x,
		y,
		width,
		height,
		rootToken:
			rect.rootToken && typeof rect.rootToken === "string"
				? rect.rootToken
				: undefined,
	}
}
