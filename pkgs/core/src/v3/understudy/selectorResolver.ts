import {
	type LocatorScriptName,
	locatorScriptBootstrap,
	locatorScriptGlobalRefs,
} from "@handstage/dom/build/locatorScripts.generated"
import type { Protocol } from "devtools-protocol"
import { LogLevel } from "../types/public/logs"
import { sendCDPWithSignal, sendCDPWithSignalAndLateResult } from "./cdp"
import { executionContexts } from "./executionContextRegistry"
import type { Frame } from "./frame"
import {
	releaseDiscardedEvaluationHandles,
	releaseObjectGroup,
	releaseObjectIds,
} from "./runtimeObjectUtils"

let selectorObjectGroupSequence = 0

export type SelectorQuery =
	| { kind: "css"; value: string }
	| { kind: "text"; value: string }
	| { kind: "xpath"; value: string }

export interface ResolvedNode {
	objectId: Protocol.Runtime.RemoteObjectId
	nodeId: Protocol.DOM.NodeId | null
	/** @internal Object group owned by the consumer while this handle is live. */
	objectGroup?: string
}

export interface ResolveManyOptions {
	limit?: number
	signal?: AbortSignal
}

export class FrameSelectorResolver {
	constructor(private readonly frame: Frame) {}

	public static parseSelector(raw: string): SelectorQuery {
		const trimmed = raw.trim()

		const isText = /^text=/i.test(trimmed)
		const looksLikeXPath =
			/^xpath=/i.test(trimmed) ||
			trimmed.startsWith("/") ||
			trimmed.startsWith("(")
		const isCssPrefixed = /^css=/i.test(trimmed)

		if (isText) {
			let value = trimmed.replace(/^text=/i, "").trim()
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1)
			}
			return { kind: "text", value }
		}

		if (looksLikeXPath) {
			const value = trimmed.replace(/^xpath=/i, "")
			return { kind: "xpath", value }
		}

		let selector = isCssPrefixed ? trimmed.replace(/^css=/i, "") : trimmed
		if (selector.includes(">>")) {
			selector = selector
				.split(">>")
				.map((piece) => piece.trim())
				.filter(Boolean)
				.join(" ")
		}

		return { kind: "css", value: selector }
	}

	public async resolveFirst(
		query: SelectorQuery,
	): Promise<ResolvedNode | null> {
		return this.resolveAtIndex(query, 0)
	}

	public async resolveAll(
		query: SelectorQuery,
		{ limit = Infinity, signal }: ResolveManyOptions = {},
	): Promise<ResolvedNode[]> {
		if (limit <= 0) {
			return []
		}
		const objectGroup = signal
			? `handstage-selector-${++selectorObjectGroupSequence}`
			: undefined
		try {
			let resolved: ResolvedNode[]
			switch (query.kind) {
				case "css":
					resolved = await this.resolveCss(
						query.value,
						limit,
						signal,
						objectGroup,
					)
					break
				case "text":
					resolved = await this.resolveText(
						query.value,
						limit,
						signal,
						objectGroup,
					)
					break
				case "xpath":
					resolved = await this.resolveXPath(
						query.value,
						limit,
						signal,
						objectGroup,
					)
					break
				default:
					resolved = []
			}
			if (objectGroup && resolved.length === 0) {
				await releaseObjectGroup(this.frame.session, objectGroup)
			}
			return resolved
		} catch (error) {
			if (objectGroup) {
				void releaseObjectGroup(this.frame.session, objectGroup)
			}
			throw error
		}
	}

	public async count(query: SelectorQuery): Promise<number> {
		switch (query.kind) {
			case "css":
				return this.countCss(query.value)
			case "text":
				return this.countText(query.value)
			case "xpath":
				return this.countXPath(query.value)
			default:
				return 0
		}
	}

	public async resolveAtIndex(
		query: SelectorQuery,
		index: number,
		signal?: AbortSignal,
	): Promise<ResolvedNode | null> {
		if (index < 0 || !Number.isFinite(index)) {
			return null
		}
		const results = await this.resolveAll(query, { limit: index + 1, signal })
		const selected = results[index] ?? null
		const objectGroups = [
			...new Set(results.map((result) => result.objectGroup)),
		].filter((group): group is string => Boolean(group))
		try {
			await releaseObjectIds(
				this.frame.session,
				results
					.filter((result) => result !== selected)
					.map((result) => result.objectId),
				signal,
			)
			signal?.throwIfAborted()
		} catch (error) {
			await Promise.allSettled(
				objectGroups.map((group) =>
					releaseObjectGroup(this.frame.session, group),
				),
			)
			throw error
		}
		if (!selected) {
			await Promise.allSettled(
				objectGroups.map((group) =>
					releaseObjectGroup(this.frame.session, group),
				),
			)
		}
		return selected
	}

	private buildLocatorInvocation(
		name: LocatorScriptName,
		args: string[],
	): string {
		const call = `${locatorScriptGlobalRefs[name]}(${args.join(", ")})`
		return `(() => { ${locatorScriptBootstrap}; return ${call}; })()`
	}

	private async resolveCss(
		selector: string,
		limit: number,
		signal?: AbortSignal,
		objectGroup?: string,
	): Promise<ResolvedNode[]> {
		if (limit <= 0) {
			return []
		}

		const session = this.frame.session
		const isolatedWorldParams = {
			frameId: this.frame.frameId,
			worldName: "v3-world",
		}
		const { executionContextId } = signal
			? await sendCDPWithSignal(
					session,
					"Page.createIsolatedWorld",
					signal,
					isolatedWorldParams,
				)
			: await session.send("Page.createIsolatedWorld", isolatedWorldParams)

		const ctxId = await executionContexts.waitForMainWorld(
			session,
			this.frame.frameId,
			1000,
			signal,
		)

		const results: ResolvedNode[] = []
		let loggedFallback = false

		for (let index = 0; index < limit; index += 1) {
			const primaryExpr = this.buildLocatorInvocation("resolveCssSelector", [
				JSON.stringify(selector),
				String(index),
			])
			const primary = await this.evaluateElement(
				primaryExpr,
				executionContextId,
				signal,
				objectGroup,
			)
			if (primary) {
				results.push(primary)
				continue
			}

			if (!loggedFallback) {
				this.frame.logger({
					category: "locator",
					message: "css pierce-fallback",
					level: LogLevel.Debug,
					attributes: {
						frameId: this.frame.frameId,
						selector,
					},
				})
				loggedFallback = true
			}

			const fallbackExpr = this.buildLocatorInvocation(
				"resolveCssSelectorPierce",
				[JSON.stringify(selector), String(index)],
			)
			const fallback = await this.evaluateElement(
				fallbackExpr,
				ctxId,
				signal,
				objectGroup,
			)
			if (fallback) {
				results.push(fallback)
				continue
			}

			break
		}

		return results
	}

	private async resolveText(
		value: string,
		limit: number,
		signal?: AbortSignal,
		objectGroup?: string,
	): Promise<ResolvedNode[]> {
		if (limit <= 0) {
			return []
		}

		const session = this.frame.session
		const ctxId = await executionContexts.waitForMainWorld(
			session,
			this.frame.frameId,
			1000,
			signal,
		)

		const results: ResolvedNode[] = []
		for (let index = 0; index < limit; index += 1) {
			const expr = this.buildLocatorInvocation("resolveTextSelector", [
				JSON.stringify(value),
				String(index),
			])
			const resolved = await this.evaluateElement(
				expr,
				ctxId,
				signal,
				objectGroup,
			)
			if (!resolved) {
				break
			}
			results.push(resolved)
		}

		return results
	}

	private async resolveXPath(
		value: string,
		limit: number,
		signal?: AbortSignal,
		objectGroup?: string,
	): Promise<ResolvedNode[]> {
		if (limit <= 0) {
			return []
		}

		const session = this.frame.session
		const ctxId = await executionContexts.waitForMainWorld(
			session,
			this.frame.frameId,
			1000,
			signal,
		)

		const results: ResolvedNode[] = []
		for (let index = 0; index < limit; index += 1) {
			const expr = this.buildLocatorInvocation("resolveXPathMainWorld", [
				JSON.stringify(value),
				String(index),
			])
			const resolved = await this.evaluateElement(
				expr,
				ctxId,
				signal,
				objectGroup,
			)
			if (!resolved) {
				break
			}
			results.push(resolved)
		}

		return results
	}

	private async countCss(selector: string): Promise<number> {
		const session = this.frame.session

		const { executionContextId } = await session.send(
			"Page.createIsolatedWorld",
			{
				frameId: this.frame.frameId,
				worldName: "v3-world",
			},
		)

		const primaryExpr = this.buildLocatorInvocation("countCssMatchesPrimary", [
			JSON.stringify(selector),
		])
		const primary = await this.evaluateCount(primaryExpr, executionContextId)

		const ctxId = await executionContexts.waitForMainWorld(
			session,
			this.frame.frameId,
			1000,
		)

		const fallbackExpr = this.buildLocatorInvocation("countCssMatchesPierce", [
			JSON.stringify(selector),
		])
		const fallback = await this.evaluateCount(fallbackExpr, ctxId)

		return Math.max(primary, fallback)
	}

	private async countText(value: string): Promise<number> {
		const session = this.frame.session
		const ctxId = await executionContexts.waitForMainWorld(
			session,
			this.frame.frameId,
			1000,
		)

		const expr = this.buildLocatorInvocation("countTextMatches", [
			JSON.stringify(value),
		])

		try {
			const evalRes = await session.send("Runtime.evaluate", {
				expression: expr,
				contextId: ctxId,
				returnByValue: true,
				awaitPromise: true,
			})
			await releaseDiscardedEvaluationHandles(session, evalRes)

			if (evalRes.exceptionDetails) {
				const details = evalRes.exceptionDetails
				this.frame.logger({
					category: "locator",
					message: "count text evaluate exception",
					level: LogLevel.Error,
					attributes: {
						frameId: this.frame.frameId,
						selector: value,
						exception:
							details.text ??
							String(
								details.exception?.description ??
									details.exception?.value ??
									"",
							),
					},
				})
				return 0
			}

			const data = (evalRes.result.value ?? {}) as {
				count?: unknown
			}

			const num =
				typeof data.count === "number" ? data.count : Number(data.count)
			if (!Number.isFinite(num)) {
				return 0
			}
			return Math.max(0, Math.floor(num))
		} catch {
			return 0
		}
	}

	private async countXPath(value: string): Promise<number> {
		const session = this.frame.session

		const ctxId = await executionContexts.waitForMainWorld(
			session,
			this.frame.frameId,
			1000,
		)

		const expr = this.buildLocatorInvocation("countXPathMatchesMainWorld", [
			JSON.stringify(value),
		])

		try {
			const evalRes = await session.send("Runtime.evaluate", {
				expression: expr,
				contextId: ctxId,
				returnByValue: true,
				awaitPromise: true,
			})
			await releaseDiscardedEvaluationHandles(session, evalRes)

			if (evalRes.exceptionDetails) {
				return 0
			}

			const num =
				typeof evalRes.result.value === "number"
					? evalRes.result.value
					: Number(evalRes.result.value)
			if (!Number.isFinite(num)) {
				return 0
			}
			return Math.max(0, Math.floor(num))
		} catch {
			return 0
		}
	}

	private async resolveFromObjectId(
		objectId: Protocol.Runtime.RemoteObjectId,
		signal?: AbortSignal,
		objectGroup?: string,
	): Promise<ResolvedNode | null> {
		const session = this.frame.session
		let nodeId: Protocol.DOM.NodeId | null
		try {
			const rn = signal
				? await sendCDPWithSignal(session, "DOM.requestNode", signal, {
						objectId,
					})
				: await session.send("DOM.requestNode", { objectId })
			nodeId = rn.nodeId ?? null
		} catch (error) {
			if (signal?.aborted) {
				throw error
			}
			nodeId = null
		}

		return { objectId, nodeId, ...(objectGroup ? { objectGroup } : {}) }
	}

	private async evaluateCount(
		expression: string,
		contextId: Protocol.Runtime.ExecutionContextId,
	): Promise<number> {
		const session = this.frame.session

		try {
			const evalRes = await session.send("Runtime.evaluate", {
				expression,
				contextId,
				returnByValue: true,
				awaitPromise: true,
			})
			await releaseDiscardedEvaluationHandles(session, evalRes)

			if (evalRes.exceptionDetails) {
				return 0
			}

			const value = evalRes.result.value
			const num = typeof value === "number" ? value : Number(value)
			if (!Number.isFinite(num)) {
				return 0
			}
			return Math.max(0, Math.floor(num))
		} catch {
			return 0
		}
	}

	private async evaluateElement(
		expression: string,
		contextId: Protocol.Runtime.ExecutionContextId,
		signal?: AbortSignal,
		objectGroup?: string,
	): Promise<ResolvedNode | null> {
		const session = this.frame.session
		let objectId: Protocol.Runtime.RemoteObjectId | undefined

		try {
			const params = {
				expression,
				contextId,
				returnByValue: false,
				awaitPromise: true,
				objectGroup,
			}
			const evalRes = signal
				? await sendCDPWithSignalAndLateResult(
						session,
						"Runtime.evaluate",
						signal,
						() =>
							objectGroup
								? releaseObjectGroup(session, objectGroup)
								: undefined,
						params,
					)
				: await session.send("Runtime.evaluate", params)

			if (evalRes.exceptionDetails || !evalRes.result.objectId) {
				await releaseDiscardedEvaluationHandles(session, evalRes)
				return null
			}

			objectId = evalRes.result.objectId
			const resolved = await this.resolveFromObjectId(
				objectId,
				signal,
				objectGroup,
			)
			objectId = undefined
			return resolved
		} catch (error) {
			if (objectId) {
				const cleanup = releaseObjectIds(session, [objectId])
				if (signal?.aborted) {
					void cleanup
				} else {
					await cleanup
				}
			}
			if (signal?.aborted) {
				throw error
			}
			return null
		}
	}
}
