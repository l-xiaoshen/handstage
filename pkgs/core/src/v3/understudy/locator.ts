import {
	locatorScriptBootstrap,
	locatorScriptGlobalRefs,
	locatorScriptSources,
} from "@handstage/dom/build/locatorScripts.generated"
import type { Protocol } from "devtools-protocol"
import type {
	MouseButton,
	SetInputFilePayload,
	SetInputFilesArgument,
} from "../types/public/locator"
import {
	ElementNotVisibleError,
	HandstageElementNotFoundError,
	HandstageInvalidArgumentError,
	HandstageLocatorError,
} from "../types/public/sdkErrors"
import { sendCDPWithSignal } from "./cdp"
import type { Frame } from "./frame"
import {
	releaseDiscardedEvaluationHandles,
	releaseObjectIds,
} from "./runtimeObjectUtils"
import { FrameSelectorResolver, type SelectorQuery } from "./selectorResolver"

const MAX_REMOTE_UPLOAD_BYTES = 50 * 1024 * 1024 // 50MB guard copied from Playwright

/**
 * Locator
 *
 * Purpose:
 * A small, CDP-based element interaction helper scoped to a specific `Frame`.
 * It resolves a CSS/XPath selector inside the frame’s **isolated world**, and then
 * performs low-level actions (click, type, select) using DOM/Runtime/Input
 * protocol domains with minimal abstraction.
 *
 * Key change:
 * - Prefer **objectId**-based CDP calls (scroll, geometry) to avoid brittle
 *   frontend nodeId mappings. nodeId is resolved on a best-effort basis and
 *   returned for compatibility, but actions do not depend on it.
 *
 * Notes:
 * - Resolution is lazy: every action resolves the selector again.
 * - Uses `Page.createIsolatedWorld` so evaluation is isolated from page scripts.
 * - Releases remote objects (`Runtime.releaseObject`) where appropriate.
 */
export class Locator {
	private readonly selectorResolver: FrameSelectorResolver

	private readonly selectorQuery: SelectorQuery

	// -1 means "no explicit nth()"; default locator resolves to first match for actions.
	private readonly nthIndex: number

	constructor(
		private readonly frame: Frame,
		private readonly selector: string,
		private readonly options?: { deep?: boolean; depth?: number },
		nthIndex: number = -1,
	) {
		this.selectorResolver = new FrameSelectorResolver(this.frame)
		this.selectorQuery = FrameSelectorResolver.parseSelector(selector)
		const normalized = Number.isFinite(nthIndex) ? Math.floor(nthIndex) : -1
		this.nthIndex = normalized < 0 ? -1 : normalized
	}

	/** Return the owning Frame for this locator (typed accessor, no private access). */
	public getFrame(): Frame {
		return this.frame
	}

	/**
	 * Set files on an <input type="file"> element.
	 *
	 * Mirrors Playwright's Locator.setInputFiles basics:
	 * - Accepts file path(s) or payload object(s) { name, mimeType, buffer }.
	 * - Uses CDP DOM.setFileInputFiles under the hood.
	 * - Best‑effort dispatches change/input via CDP (Chrome does by default).
	 * - Passing an empty array clears the selection.
	 */
	public async setInputFiles(files: SetInputFilesArgument): Promise<void> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()

		try {
			try {
				const res = await session.send("Runtime.callFunctionOn", {
					objectId,
					functionDeclaration: locatorScriptSources.ensureFileInputElement,
					returnByValue: true,
				})
				const ok = Boolean(res.result.value)
				await releaseDiscardedEvaluationHandles(session, res)
				if (!ok) {
					throw new HandstageInvalidArgumentError(
						'Target is not an <input type="file"> element',
					)
				}
			} catch (e) {
				throw new HandstageInvalidArgumentError(
					e instanceof Error
						? e.message
						: "Unable to verify file input element",
				)
			}

			const normalized = Array.isArray(files) ? files : [files]

			if (!normalized.length) {
				await session.send("DOM.setFileInputFiles", {
					objectId,
					files: [],
				})
				return
			}

			await this.assignFilesViaPayloadInjection(objectId, normalized)
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Remote browser fallback: build File objects inside the page and attach them via JS.
	 *
	 * When Handstage is driving a browser that cannot see the local filesystem (e.g. remote
	 * CDP), CDP's DOM.setFileInputFiles would fail because Chrome can't reach
	 * our temp files. Instead we base64-encode the payloads, send them into the page, and
	 * let a DOM helper create File objects + dispatch change/input events.
	 */
	private async assignFilesViaPayloadInjection(
		objectId: Protocol.Runtime.RemoteObjectId,
		files: SetInputFilePayload[],
	): Promise<void> {
		const session = this.frame.session

		for (const payload of files) {
			if (payload.buffer.length > MAX_REMOTE_UPLOAD_BYTES) {
				throw new HandstageInvalidArgumentError(
					`setInputFiles(): file "${payload.name}" is larger than the 50MB limit for remote uploads`,
				)
			}
		}

		const serialized = files.map((payload) => {
			let binary = ""
			const len = payload.buffer.byteLength
			const chunkSize = 8192
			for (let i = 0; i < len; i += chunkSize) {
				const chunk = payload.buffer.subarray(i, i + chunkSize)
				binary += String.fromCharCode(...chunk)
			}
			return {
				name: payload.name,
				mimeType: payload.mimeType || "application/octet-stream",
				lastModified: payload.lastModified || Date.now(),
				base64: btoa(binary),
			}
		})

		const res = await session.send("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration:
				locatorScriptSources.assignFilePayloadsToInputElement,
			arguments: [
				{
					value: serialized,
				},
			],
			returnByValue: true,
		})

		const ok = Boolean(res.result?.value)
		await releaseDiscardedEvaluationHandles(session, res)
		if (!ok) {
			throw new HandstageInvalidArgumentError(
				"Unable to assign file payloads to remote input element",
			)
		}
	}

	/**
	 * Return the DOM backendNodeId for this locator's target element.
	 * Useful for identity comparisons without needing element handles.
	 */
	async backendNodeId(): Promise<Protocol.DOM.BackendNodeId> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			await session.send("DOM.enable").catch(() => {})
			const { node } = await session.send("DOM.describeNode", { objectId })
			return node.backendNodeId
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/** Return how many nodes the current selector resolves to. */
	public async count(): Promise<number> {
		const session = this.frame.session
		await session.send("Runtime.enable")
		await session.send("DOM.enable")
		return this.selectorResolver.count(this.selectorQuery)
	}

	/**
	 * Return the center of the element's bounding box in the owning frame's viewport
	 * (CSS pixels), rounded to integers. Scrolls into view best-effort.
	 */
	public async centroid(): Promise<{ x: number; y: number }> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			await session
				.send("DOM.scrollIntoViewIfNeeded", { objectId })
				.catch(() => {})
			const box = await session.send("DOM.getBoxModel", { objectId })
			if (!box.model) {
				throw new ElementNotVisibleError(this.selector)
			}
			const { cx, cy } = this.centerFromBoxContent(box.model.content)
			return { x: Math.round(cx), y: Math.round(cy) }
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Highlight the element's bounding box using the CDP Overlay domain.
	 * - Scrolls element into view best-effort.
	 * - Shows a semi-transparent overlay briefly, then hides it.
	 */
	public async highlight(options?: {
		durationMs?: number
		borderColor?: { r: number; g: number; b: number; a?: number }
		contentColor?: { r: number; g: number; b: number; a?: number }
	}): Promise<void> {
		const session = this.frame.session
		const resolutionSignal = this.frame.combineWithDisposalSignal(
			new AbortController().signal,
		)
		const { objectId } = await this.resolveNode(resolutionSignal)
		const duration = Math.max(0, options?.durationMs ?? 800)

		const borderColor = options?.borderColor ?? { r: 255, g: 0, b: 0, a: 0.9 }
		const contentColor =
			options?.contentColor ?? ({ r: 255, g: 200, b: 0, a: 0.2 } as const)
		let highlightDispatched = false
		const runBounded = async <T>(
			operation: (signal: AbortSignal) => Promise<T>,
		): Promise<T> => {
			const controller = new AbortController()
			const timer = setTimeout(
				() => controller.abort(new Error("Overlay command timed out")),
				1000,
			)
			try {
				return await operation(
					this.frame.combineWithDisposalSignal(controller.signal),
				)
			} finally {
				clearTimeout(timer)
			}
		}

		try {
			await runBounded((signal) =>
				sendCDPWithSignal(session, "Overlay.enable", signal),
			).catch(() => {})
			await runBounded((signal) =>
				sendCDPWithSignal(session, "DOM.scrollIntoViewIfNeeded", signal, {
					objectId,
				}),
			).catch(() => {})

			await runBounded((signal) =>
				sendCDPWithSignal(session, "DOM.enable", signal),
			).catch(() => {})
			let backendNodeId: Protocol.DOM.BackendNodeId | undefined
			try {
				const { node } = await runBounded((signal) =>
					sendCDPWithSignal(session, "DOM.describeNode", signal, { objectId }),
				)
				backendNodeId = node.backendNodeId
			} catch {
				backendNodeId = undefined
			}

			const highlightConfig: Protocol.Overlay.HighlightConfig = {
				showInfo: false,
				showStyles: false,
				showRulers: false,
				showExtensionLines: false,
				borderColor,
				contentColor,
			}

			const highlightOnce = async (initial = false) => {
				await runBounded(async (signal) => {
					signal.throwIfAborted()
					if (initial) {
						highlightDispatched = true
					}
					await sendCDPWithSignal(session, "Overlay.highlightNode", signal, {
						...(backendNodeId ? { backendNodeId } : { objectId }),
						highlightConfig,
					})
				})
			}

			await highlightOnce(true)

			if (duration > 0) {
				const start = Date.now()
				const tick = Math.min(300, Math.max(100, Math.floor(duration / 50)))
				while (Date.now() - start < duration) {
					await this.frame.waitForDelay(tick)
					try {
						await highlightOnce()
					} catch {}
				}
			}
		} finally {
			const cleanupTasks: Promise<unknown>[] = []
			if (highlightDispatched) {
				const cleanupController = new AbortController()
				const timer = setTimeout(
					() => cleanupController.abort(new Error("Overlay cleanup timed out")),
					1000,
				)
				cleanupTasks.push(
					sendCDPWithSignal(
						session,
						"Overlay.hideHighlight",
						cleanupController.signal,
					)
						.catch(() => {})
						.finally(() => clearTimeout(timer)),
				)
			}
			cleanupTasks.push(releaseObjectIds(session, [objectId]))
			await Promise.allSettled(cleanupTasks)
		}
	}

	/**
	 * Move the mouse cursor to the element's visual center without clicking.
	 * - Scrolls into view best-effort, resolves geometry, then dispatches a mouse move.
	 */
	async hover(): Promise<void> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			await session
				.send("DOM.scrollIntoViewIfNeeded", { objectId })
				.catch(() => {})

			const box = await session.send("DOM.getBoxModel", { objectId })
			if (!box.model) {
				throw new ElementNotVisibleError(this.selector)
			}
			const { cx, cy } = this.centerFromBoxContent(box.model.content)

			await session.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: cx,
				y: cy,
				button: "none",
			})
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Click the element at its visual center.
	 * Steps:
	 *  1) Resolve selector to { objectId } in the frame world.
	 *  2) Scroll into view via `DOM.scrollIntoViewIfNeeded({ objectId })`.
	 *  3) Read geometry via `DOM.getBoxModel({ objectId })` → compute a center point.
	 *  4) Synthesize mouse press + release via `Input.dispatchMouseEvent`.
	 */
	async click(options?: {
		button?: MouseButton
		clickCount?: number
	}): Promise<void> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()

		const button = options?.button ?? "left"
		const clickCount = options?.clickCount ?? 1

		try {
			await session.send("DOM.scrollIntoViewIfNeeded", { objectId })

			const box = await session.send("DOM.getBoxModel", { objectId })
			if (!box.model) {
				throw new ElementNotVisibleError(this.selector)
			}
			const { cx, cy } = this.centerFromBoxContent(box.model.content)

			const dispatches: Array<Promise<unknown>> = []
			dispatches.push(
				session.send("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x: cx,
					y: cy,
					button: "none",
				}),
			)

			for (let i = 1; i <= clickCount; i++) {
				dispatches.push(
					session.send("Input.dispatchMouseEvent", {
						type: "mousePressed",
						x: cx,
						y: cy,
						button,
						clickCount: i,
					}),
				)
				dispatches.push(
					session.send("Input.dispatchMouseEvent", {
						type: "mouseReleased",
						x: cx,
						y: cy,
						button,
						clickCount: i,
					}),
				)
			}
			await Promise.all(dispatches)
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Dispatch a DOM 'click' MouseEvent on the element itself.
	 * - Does not synthesize real pointer input; directly dispatches an event.
	 * - Useful for elements that rely on click handlers without needing hit-testing.
	 */
	async sendClickEvent(options?: {
		bubbles?: boolean
		cancelable?: boolean
		composed?: boolean
		detail?: number
	}): Promise<void> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		const bubbles = options?.bubbles ?? true
		const cancelable = options?.cancelable ?? true
		const composed = options?.composed ?? true
		const detail = options?.detail ?? 1
		try {
			await session
				.send("DOM.scrollIntoViewIfNeeded", { objectId })
				.catch(() => {})
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.dispatchDomClick,
				arguments: [
					{
						value: { bubbles, cancelable, composed, detail },
					},
				],
				returnByValue: true,
			})
			await releaseDiscardedEvaluationHandles(session, res)
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Scroll the element vertically to a given percentage (0–100).
	 * - If the element is <html> or <body>, scrolls the window/document.
	 * - Otherwise, scrolls the element itself via element.scrollTo.
	 */
	async scrollTo(percent: number | string): Promise<void> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.scrollElementToPercent,
				arguments: [{ value: percent }],
				returnByValue: true,
			})
			await releaseDiscardedEvaluationHandles(session, res)
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Fill an input/textarea/contenteditable element.
	 * Mirrors Playwright semantics: the DOM helper either applies the native
	 * value setter (for special input types) or asks us to type text via the CDP
	 * Input domain after focusing/selecting.
	 */
	async fill(value: string): Promise<void> {
		const session = this.frame.session
		const fillDeclaration = `function(value) { ${locatorScriptBootstrap}; return ${locatorScriptGlobalRefs.fillElementValue}.call(this, value); }`
		const { objectId } = await this.resolveNode()

		let releaseNeeded = true

		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: fillDeclaration,
				arguments: [{ value }],
				returnByValue: true,
			})
			if (res.exceptionDetails) {
				const message =
					res.exceptionDetails.exception?.description ??
					res.exceptionDetails.text ??
					"Unknown exception during locator().fill()"
				await releaseDiscardedEvaluationHandles(session, res)
				throw new HandstageLocatorError("Filling", this.selector, message)
			}

			const result = res.result.value as
				| { status?: string; reason?: string; value?: string }
				| null
				| undefined
			await releaseDiscardedEvaluationHandles(session, res)
			const status =
				typeof result === "object" && result ? result.status : undefined

			if (status === "done") {
				return
			}

			if (status === "needsinput") {
				await releaseObjectIds(session, [objectId])
				releaseNeeded = false

				const valueToType =
					typeof result?.value === "string" ? result.value : value

				let prepared = false
				try {
					const { objectId: prepObjectId } = await this.resolveNode()
					try {
						const prepRes = await session.send("Runtime.callFunctionOn", {
							objectId: prepObjectId,
							functionDeclaration: locatorScriptSources.prepareElementForTyping,
							returnByValue: true,
						})
						prepared = Boolean(prepRes.result.value)
						await releaseDiscardedEvaluationHandles(session, prepRes)
					} finally {
						await releaseObjectIds(session, [prepObjectId])
					}
				} catch {
					// Ignore preparation failures; we'll fall back to typing best-effort.
				}

				if (!prepared && valueToType.length > 0) {
					await this.type(valueToType)
					return
				}

				if (valueToType.length === 0) {
					await session.send("Input.dispatchKeyEvent", {
						type: "keyDown",
						key: "Backspace",
						code: "Backspace",
						windowsVirtualKeyCode: 8,
						nativeVirtualKeyCode: 8,
					})
					await session.send("Input.dispatchKeyEvent", {
						type: "keyUp",
						key: "Backspace",
						code: "Backspace",
						windowsVirtualKeyCode: 8,
						nativeVirtualKeyCode: 8,
					})
				} else {
					await session.send("Input.insertText", { text: valueToType })
				}

				return
			}

			if (status === "error") {
				const reason =
					typeof result?.reason === "string" && result.reason.length > 0
						? result.reason
						: "Failed to fill element"
				throw new HandstageInvalidArgumentError(
					`Failed to fill element (${reason})`,
				)
			}

			if (!status) {
				await this.type(value)
			}
		} finally {
			if (releaseNeeded) {
				await releaseObjectIds(session, [objectId])
			}
		}
	}

	/**
	 * Type text into the element (focuses first).
	 * - Focus via element.focus() in page JS (no DOM.focus(nodeId)).
	 * - If no delay, uses `Input.insertText` for efficiency.
	 * - With delay, synthesizes `keyDown`/`keyUp` per character.
	 */
	async type(text: string, options?: { delay?: number }): Promise<void> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()

		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.focusElement,
				returnByValue: true,
			})
			await releaseDiscardedEvaluationHandles(session, res)

			if (!options?.delay) {
				await session.send("Input.insertText", { text })
				return
			}

			for (const ch of text) {
				await session.send("Input.dispatchKeyEvent", {
					type: "keyDown",
					text: ch,
					key: ch,
				})

				await session.send("Input.dispatchKeyEvent", {
					type: "keyUp",
					text: ch,
					key: ch,
				})

				await this.frame.waitForDelay(options.delay)
			}
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Select one or more options on a `<select>` element.
	 * Returns the values actually selected after the operation.
	 */
	async selectOption(values: string | string[]): Promise<string[]> {
		const session = this.frame.session
		const desired = Array.isArray(values) ? values : [values]
		const { objectId } = await this.resolveNode()

		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.selectElementOptions,
				arguments: [{ value: desired }],
				returnByValue: true,
			})

			const selected = Array.isArray(res.result.value)
				? res.result.value.filter(
						(value): value is string => typeof value === "string",
					)
				: []
			await releaseDiscardedEvaluationHandles(session, res)
			return selected
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Return true if the element is attached and visible (rough heuristic).
	 */
	async isVisible(): Promise<boolean> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.isElementVisible,
				returnByValue: true,
			})
			const visible = Boolean(res.result.value)
			await releaseDiscardedEvaluationHandles(session, res)
			return visible
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Return true if the element is an input[type=checkbox|radio] and is checked.
	 * Also considers aria-checked for ARIA widgets.
	 */
	async isChecked(): Promise<boolean> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.isElementChecked,
				returnByValue: true,
			})
			const checked = Boolean(res.result.value)
			await releaseDiscardedEvaluationHandles(session, res)
			return checked
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Return the element's input value (for input/textarea/select/contenteditable).
	 */
	async inputValue(): Promise<string> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.readElementInputValue,
				returnByValue: true,
			})
			const value = String(res.result.value ?? "")
			await releaseDiscardedEvaluationHandles(session, res)
			return value
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Return the element's textContent (raw, not innerText).
	 */
	async textContent(): Promise<string> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.readElementTextContent,
				returnByValue: true,
			})
			const value = String(res.result.value ?? "")
			await releaseDiscardedEvaluationHandles(session, res)
			return value
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Return the element's innerHTML string.
	 */
	async innerHtml(): Promise<string> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.readElementInnerHTML,
				returnByValue: true,
			})
			const html = String(res.result.value ?? "")
			await releaseDiscardedEvaluationHandles(session, res)
			return html
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Return the element's innerText (layout-aware, visible text).
	 */
	async innerText(): Promise<string> {
		const session = this.frame.session
		const { objectId } = await this.resolveNode()
		try {
			const res = await session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: locatorScriptSources.readElementInnerText,
				returnByValue: true,
			})
			const text = String(res.result.value ?? "")
			await releaseDiscardedEvaluationHandles(session, res)
			return text
		} finally {
			await releaseObjectIds(session, [objectId])
		}
	}

	/**
	 * Return a locator narrowed to the first match.
	 */
	first(): Locator {
		return this.nth(0)
	}

	/** Return a locator narrowed to the element at the given zero-based index. */
	nth(index: number): Locator {
		const value = Number(index)
		if (!Number.isFinite(value) || value < 0) {
			throw new HandstageInvalidArgumentError(
				"locator().nth() expects a non-negative index",
			)
		}

		const nextIndex = Math.floor(value)
		if (nextIndex === this.nthIndex) {
			return this
		}

		return new Locator(this.frame, this.selector, this.options, nextIndex)
	}

	/**
	 * Resolve `this.selector` within the frame to `{ objectId, nodeId? }`:
	 * Delegates to a shared selector resolver so all selector logic stays in sync.
	 */
	public async resolveNode(signal?: AbortSignal): Promise<{
		nodeId: Protocol.DOM.NodeId | null
		objectId: Protocol.Runtime.RemoteObjectId
	}> {
		const session = this.frame.session

		if (signal) {
			await sendCDPWithSignal(session, "Runtime.enable", signal)
			await sendCDPWithSignal(session, "DOM.enable", signal)
		} else {
			await session.send("Runtime.enable")
			await session.send("DOM.enable")
		}

		const index = this.nthIndex < 0 ? 0 : this.nthIndex
		const resolved = await this.selectorResolver.resolveAtIndex(
			this.selectorQuery,
			index,
			signal,
		)
		if (!resolved) {
			throw new HandstageElementNotFoundError([this.selector])
		}

		return resolved
	}

	/**
	 * Resolve all matching nodes for this locator.
	 * If the locator is narrowed via nth(), only that index is returned.
	 */
	public async resolveNodesForMask(signal?: AbortSignal): Promise<
		Array<{
			nodeId: Protocol.DOM.NodeId | null
			objectId: Protocol.Runtime.RemoteObjectId
			objectGroup?: string
		}>
	> {
		const session = this.frame.session

		if (signal) {
			await sendCDPWithSignal(session, "Runtime.enable", signal)
			await sendCDPWithSignal(session, "DOM.enable", signal)
		} else {
			await session.send("Runtime.enable")
			await session.send("DOM.enable")
		}

		if (this.nthIndex >= 0) {
			const resolved = await this.selectorResolver.resolveAtIndex(
				this.selectorQuery,
				this.nthIndex,
				signal,
			)
			if (!resolved) {
				throw new HandstageElementNotFoundError([this.selector])
			}
			return [resolved]
		}

		const resolved = await this.selectorResolver.resolveAll(
			this.selectorQuery,
			{
				signal,
			},
		)
		if (!resolved.length) {
			throw new HandstageElementNotFoundError([this.selector])
		}
		return resolved
	}

	/** Compute a center point from a BoxModel content quad */
	private centerFromBoxContent(content: number[]): { cx: number; cy: number } {
		if (!content || content.length < 8) {
			throw new HandstageInvalidArgumentError("Invalid box model content quad")
		}
		const [x1, y1, x2, y2, x3, y3, x4, y4] = content
		if (
			x1 === undefined ||
			y1 === undefined ||
			x2 === undefined ||
			y2 === undefined ||
			x3 === undefined ||
			y3 === undefined ||
			x4 === undefined ||
			y4 === undefined
		) {
			throw new HandstageInvalidArgumentError("Invalid box model content quad")
		}
		const cx = (x1 + x2 + x3 + x4) / 4
		const cy = (y1 + y2 + y3 + y4) / 4
		return { cx, cy }
	}
}
