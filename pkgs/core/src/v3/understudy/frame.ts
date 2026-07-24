import type { Protocol } from "devtools-protocol"
import { defaultLogger, type LogSink } from "../logger"
import { HandstageEvalError } from "../types/public/sdkErrors"
import {
	type CDPSessionLike,
	sendCDPWithSignal,
	sendCDPWithSignalAndLateResult,
} from "./cdp"
import { executionContexts } from "./executionContextRegistry"
import { Locator } from "./locator"
import {
	isFrameScopeError,
	isMissingExecutionContextError,
} from "./protocolError"
import {
	raceCleanupAgainstAbort,
	releaseDiscardedEvaluationHandles,
	releaseObjectGroup,
} from "./runtimeObjectUtils"

let frameEvaluationObjectGroupSequence = 0

interface FrameManager {
	session: CDPSessionLike
	frameId: string
	pageId: string
}

/**
 * Frame
 *
 * A thin, session-bound handle to a specific DOM frame (by frameId).
 * All CDP calls in this class go through `this.session`, which MUST be the
 * owning session for `this.frameId`. Page is responsible for constructing
 * Frames with the correct session.
 */
export class Frame implements FrameManager {
	/** Owning CDP session id (useful for logs); null for root connection (should not happen for targets) */
	public readonly sessionId: string | null

	/**
	 * Logger inherited from the owning {@link Page} (which inherits from
	 * {@link Context}).  Used by helpers that operate against a `Frame`
	 * (selectorResolver, snapshot capture) to keep per-instance log routing
	 * intact for multi-context callers.
	 */
	public readonly logger: LogSink

	constructor(
		public session: CDPSessionLike,
		public frameId: string,
		public pageId: string,
		private readonly remoteBrowser: boolean,
		logger?: LogSink,
		private readonly disposalSignal?: AbortSignal,
	) {
		this.sessionId = this.session.id ?? null
		this.logger = logger ?? defaultLogger()
	}

	/** True when the controlled browser runs on a different machine. */
	public isBrowserRemote(): boolean {
		return this.remoteBrowser
	}

	/** DOM.getNodeForLocation → DOM.describeNode */
	async getNodeAtLocation(x: number, y: number): Promise<Protocol.DOM.Node> {
		await this.session.send("DOM.enable")
		const { backendNodeId } = await this.session.send(
			"DOM.getNodeForLocation",
			{
				x,
				y,
				includeUserAgentShadowDOM: true,
				ignorePointerEventsNone: false,
			},
		)

		const { node } = await this.session.send("DOM.describeNode", {
			backendNodeId,
		})

		return node
	}

	/** CSS selector → DOM.querySelector → DOM.getBoxModel */
	async getLocationForSelector(
		selector: string,
	): Promise<{ x: number; y: number; width: number; height: number }> {
		await this.session.send("DOM.enable")

		const { root } = await this.session.send("DOM.getDocument")

		const { nodeId } = await this.session.send("DOM.querySelector", {
			nodeId: root.nodeId,
			selector,
		})

		const { model } = await this.session.send("DOM.getBoxModel", { nodeId })

		const x = model.content[0] ?? 0
		const y = model.content[1] ?? 0
		const width = model.width ?? 0
		const height = model.height ?? 0
		return { x, y, width, height }
	}

	/** Accessibility.getFullAXTree (+ recurse into child frames if requested) */
	async getAccessibilityTree(
		withFrames = false,
	): Promise<Protocol.Accessibility.AXNode[]> {
		await this.session.send("Accessibility.enable")
		let nodes: Protocol.Accessibility.AXNode[]
		try {
			;({ nodes } = await this.session.send("Accessibility.getFullAXTree", {
				frameId: this.frameId,
			}))
		} catch (e) {
			if (!isFrameScopeError(e)) {
				throw e
			}
			// On OOPIF sessions, the unscoped call returns the child document tree.
			;({ nodes } = await this.session.send("Accessibility.getFullAXTree"))
		}

		if (!withFrames) {
			return nodes
		}

		const children = await this.childFrames()
		for (const child of children) {
			const childNodes = await child.getAccessibilityTree(false)
			nodes.push(...childNodes)
		}
		return nodes
	}

	/**
	 * Evaluate a function or expression in this frame's main world.
	 * - If a string is provided, treated as a JS expression.
	 * - If a function is provided, it is stringified and invoked with the optional argument.
	 */
	async evaluate<R = unknown, Arg = unknown>(
		pageFunctionOrExpression: string | ((arg: Arg) => R | Promise<R>),
		arg?: Arg,
		signal?: AbortSignal,
	): Promise<R> {
		return this.evaluateInternal(pageFunctionOrExpression, arg, signal, true)
	}

	/** @internal Evaluate bounded cleanup work without inheriting page disposal. */
	async evaluateForCleanup<R = unknown, Arg = unknown>(
		pageFunctionOrExpression: string | ((arg: Arg) => R | Promise<R>),
		arg?: Arg,
		signal?: AbortSignal,
	): Promise<R> {
		const timeoutController = new AbortController()
		const timer = setTimeout(
			() =>
				timeoutController.abort(
					new Error("Frame cleanup evaluation timed out"),
				),
			1000,
		)
		const cleanupSignal = signal
			? AbortSignal.any([signal, timeoutController.signal])
			: timeoutController.signal
		try {
			return await this.evaluateInternal(
				pageFunctionOrExpression,
				arg,
				cleanupSignal,
				false,
			)
		} finally {
			clearTimeout(timer)
		}
	}

	private async evaluateInternal<R = unknown, Arg = unknown>(
		pageFunctionOrExpression: string | ((arg: Arg) => R | Promise<R>),
		arg: Arg | undefined,
		signal: AbortSignal | undefined,
		includeDisposalSignal: boolean,
	): Promise<R> {
		const operationSignal =
			includeDisposalSignal && signal && this.disposalSignal
				? AbortSignal.any([signal, this.disposalSignal])
				: (signal ?? (includeDisposalSignal ? this.disposalSignal : undefined))
		if (operationSignal) {
			await sendCDPWithSignal(this.session, "Runtime.enable", operationSignal)
		} else {
			await this.session.send("Runtime.enable").catch(() => {})
		}
		const contextId = await this.getMainWorldExecutionContextId(operationSignal)

		const isString = typeof pageFunctionOrExpression === "string"
		let expression: string

		if (isString) {
			expression = String(pageFunctionOrExpression)
		} else {
			const fnSrc = pageFunctionOrExpression.toString()
			const argJson = JSON.stringify(arg)
			expression = `(() => {
        const __fn = ${fnSrc};
        const __arg = ${argJson};
        try {
          const __res = __fn(__arg);
          return Promise.resolve(__res).then(v => {
            try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
          });
        } catch (e) { throw e; }
      })()`
		}

		const objectGroup = operationSignal
			? `handstage-frame-evaluate-${++frameEvaluationObjectGroupSequence}`
			: undefined
		try {
			let res: Protocol.Runtime.EvaluateResponse
			try {
				const params = {
					expression,
					contextId,
					awaitPromise: true,
					returnByValue: true,
					objectGroup,
				}
				res = operationSignal
					? await sendCDPWithSignalAndLateResult(
							this.session,
							"Runtime.evaluate",
							operationSignal,
							() =>
								objectGroup
									? releaseObjectGroup(this.session, objectGroup)
									: undefined,
							params,
						)
					: await this.session.send("Runtime.evaluate", params)
			} catch (error) {
				if (operationSignal?.aborted) {
					throw error
				}
				// Execution contexts can be recreated between context lookup and
				// Runtime.evaluate during popup/navigate churn. Retry once with a fresh id.
				if (!isMissingExecutionContextError(error)) {
					throw error
				}
				const freshContextId =
					await this.getMainWorldExecutionContextId(operationSignal)
				const params = {
					expression,
					contextId: freshContextId,
					awaitPromise: true,
					returnByValue: true,
					objectGroup,
				}
				res = operationSignal
					? await sendCDPWithSignalAndLateResult(
							this.session,
							"Runtime.evaluate",
							operationSignal,
							() =>
								objectGroup
									? releaseObjectGroup(this.session, objectGroup)
									: undefined,
							params,
						)
					: await this.session.send("Runtime.evaluate", params)
			}
			const exceptionMessage = res.exceptionDetails
				? (res.exceptionDetails.text ?? "Evaluation failed")
				: null
			const value = res.result.value as R
			await releaseDiscardedEvaluationHandles(this.session, res)
			operationSignal?.throwIfAborted()
			if (exceptionMessage !== null) {
				throw new HandstageEvalError(exceptionMessage)
			}
			return value
		} finally {
			if (objectGroup) {
				await raceCleanupAgainstAbort(
					releaseObjectGroup(this.session, objectGroup),
					operationSignal,
				)
			}
			operationSignal?.throwIfAborted()
		}
	}

	/** Page.captureScreenshot (frame-scoped session) */
	async screenshot(options?: {
		fullPage?: boolean
		clip?: { x: number; y: number; width: number; height: number }
		type?: "png" | "jpeg"
		quality?: number
		scale?: number
		signal?: AbortSignal
	}): Promise<Uint8Array> {
		if (options?.signal) {
			await sendCDPWithSignal(this.session, "Page.enable", options.signal)
		} else {
			await this.session.send("Page.enable")
		}
		const format = options?.type ?? "png"
		const params: Protocol.Page.CaptureScreenshotRequest & { scale?: number } =
			{
				format,
				fromSurface: true,
				captureBeyondViewport: options?.fullPage,
			}

		const clampScale = (value: number): number =>
			Math.min(2, Math.max(0.1, value))

		const normalizedScale =
			typeof options?.scale === "number" ? clampScale(options.scale) : undefined

		if (options?.clip) {
			const clip = {
				x: options.clip.x,
				y: options.clip.y,
				width: options.clip.width,
				height: options.clip.height,
				scale: normalizedScale ?? 1,
			}
			params.clip = clip
		} else if (normalizedScale !== undefined && normalizedScale !== 1) {
			params.scale = normalizedScale
		}

		if (format === "jpeg" && typeof options?.quality === "number") {
			const q = Math.round(options.quality)
			params.quality = Math.min(100, Math.max(0, q))
		}

		const capture = options?.signal
			? sendCDPWithSignal(
					this.session,
					"Page.captureScreenshot",
					options.signal,
					params,
				)
			: this.session.send("Page.captureScreenshot", params)
		const { data } = await capture
		const binaryString = atob(data)
		const len = binaryString.length
		const bytes = new Uint8Array(len)
		for (let i = 0; i < len; i++) {
			bytes[i] = binaryString.charCodeAt(i)
		}
		return bytes
	}

	/** Child frames via Page.getFrameTree */
	async childFrames(): Promise<Frame[]> {
		const { frameTree } = await this.session.send("Page.getFrameTree")
		const frames: Frame[] = []

		const collect = (tree: Protocol.Page.FrameTree) => {
			if (tree.frame.parentId === this.frameId) {
				frames.push(
					new Frame(
						this.session,
						tree.frame.id,
						this.pageId,
						this.remoteBrowser,
						this.logger,
						this.disposalSignal,
					),
				)
			}
			tree.childFrames?.forEach(collect)
		}

		collect(frameTree)
		return frames
	}

	/** Wait for a lifecycle state (load/domcontentloaded/networkidle) */
	async waitForLoadState(
		state: "load" | "domcontentloaded" | "networkidle" = "load",
		timeoutMs: number = 15_000,
	): Promise<void> {
		const targetState = state.toLowerCase()
		const timeout = Math.max(0, timeoutMs)
		const timeoutController = new AbortController()
		const timer = Number.isFinite(timeout)
			? setTimeout(
					() =>
						timeoutController.abort(
							new Error(
								`waitForLoadState(${state}) timed out after ${timeout}ms for frame ${this.frameId}`,
							),
						),
					timeout,
				)
			: null
		const signal = this.disposalSignal
			? AbortSignal.any([this.disposalSignal, timeoutController.signal])
			: timeoutController.signal
		const abortError = () =>
			signal.reason instanceof Error
				? signal.reason
				: new Error("Frame lifecycle wait aborted")
		try {
			if (signal.aborted) {
				throw abortError()
			}
			await sendCDPWithSignal(this.session, "Page.enable", signal)
			if (signal.aborted) {
				throw abortError()
			}
			await new Promise<void>((resolve, reject) => {
				let done = false
				const cleanup = () => {
					this.session.off("Page.lifecycleEvent", handler)
					signal.removeEventListener("abort", onAbort)
				}
				const finish = () => {
					if (done) {
						return
					}
					done = true
					cleanup()
					resolve()
				}
				const fail = (error: Error) => {
					if (done) {
						return
					}
					done = true
					cleanup()
					reject(error)
				}
				const onAbort = () => fail(abortError())
				const handler = (evt: Protocol.Page.LifecycleEventEvent) => {
					const sameFrame = evt.frameId === this.frameId
					// need to normalize here because CDP lifecycle names look like 'DOMContentLoaded'
					// but we accept 'domcontentloaded'
					const lifecycleName = String(evt.name ?? "").toLowerCase()
					if (sameFrame && lifecycleName === targetState) {
						finish()
					}
				}
				this.session.on("Page.lifecycleEvent", handler)
				signal.addEventListener("abort", onAbort, { once: true })
				if (signal.aborted) {
					onAbort()
				}
			})
		} finally {
			if (timer) {
				clearTimeout(timer)
			}
		}
	}

	/** Simple placeholder for your own locator abstraction */
	locator(
		selector: string,
		options?: { deep?: boolean; depth?: number },
	): Locator {
		return new Locator(this, selector, options)
	}

	/** @internal Include the owning Page's disposal in a bounded operation. */
	combineWithDisposalSignal(signal: AbortSignal): AbortSignal {
		return this.disposalSignal
			? AbortSignal.any([this.disposalSignal, signal])
			: signal
	}

	/** @internal Abort interaction delays when the owning Page is disposed. */
	async waitForDelay(ms: number): Promise<void> {
		const delay = Math.max(0, ms)
		const signal = this.disposalSignal
		if (signal?.aborted) {
			throw signal.reason
		}
		if (delay === 0) {
			return
		}
		await new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
				timer = null
				signal?.removeEventListener("abort", onAbort)
				resolve()
			}, delay)
			const onAbort = () => {
				if (timer === null) {
					return
				}
				clearTimeout(timer)
				timer = null
				signal?.removeEventListener("abort", onAbort)
				reject(
					signal?.reason instanceof Error
						? signal.reason
						: new Error("Frame disposed"),
				)
			}
			signal?.addEventListener("abort", onAbort, { once: true })
		})
	}

	/** Resolve the main-world execution context id for this frame. */
	private async getMainWorldExecutionContextId(
		signal?: AbortSignal,
	): Promise<number> {
		return executionContexts.waitForMainWorld(
			this.session,
			this.frameId,
			1000,
			signal,
		)
	}
}
