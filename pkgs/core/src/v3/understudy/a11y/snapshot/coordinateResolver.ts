import { a11yScriptSources } from "@handstage/dom/build/a11yScripts.generated"
import type { Protocol } from "devtools-protocol"
import type { ResolvedLocation } from "../../../types/private/snapshot"
import { buildA11yInvocation } from "../../a11yInvocation"
import type { CDPSessionLike } from "../../cdp"
import { executionContexts } from "../../executionContextRegistry"
import type { Page } from "../../page"
import {
	releaseDiscardedEvaluationHandles,
	releaseObjectIds,
} from "../../runtimeObjectUtils"
import { listChildrenOf } from "./focusSelectors"
import { buildAbsoluteXPathFromChain } from "./xpathUtils"

/**
 * Resolve deepest node for a page coordinate and compute its absolute XPath across frames.
 * More efficient than building a full hybrid snapshot when only a single node’s XPath is needed.
 */
export async function resolveXpathForLocation(
	page: Page,
	x: number,
	y: number,
): Promise<ResolvedLocation | null> {
	const tree = page.getFullFrameTree()
	const parentByFrame = new Map<string, string | null>()
	;(function index(n: Protocol.Page.FrameTree, parent: string | null) {
		parentByFrame.set(n.frame.id, parent)
		for (const c of n.childFrames ?? []) {
			index(c, n.frame.id)
		}
	})(tree, null)

	const iframeChain: Array<{
		parentSession: CDPSessionLike
		iframeBackendNodeId: number
	}> = []

	let curFrameId = page.mainFrameId()
	let curSession = page.getSessionForFrame(curFrameId)
	let curX = x
	let curY = y

	for (let depth = 0; depth < 8; depth++) {
		try {
			await curSession.send("DOM.enable").catch(() => {})

			let sx = 0
			let sy = 0
			try {
				await curSession.send("Runtime.enable").catch(() => {})
				const ctxId = await executionContexts
					.waitForMainWorld(curSession, curFrameId)
					.catch(() => {})
				const scrollExpr = buildA11yInvocation("getScrollOffsets", [])
				const evalParams = ctxId
					? {
							contextId: ctxId,
							expression: scrollExpr,
							returnByValue: true,
						}
					: { expression: scrollExpr, returnByValue: true }
				const evaluation = await curSession.send("Runtime.evaluate", evalParams)
				await releaseDiscardedEvaluationHandles(curSession, evaluation)
				if (!evaluation.exceptionDetails) {
					sx = Number(evaluation.result.value?.sx ?? 0)
					sy = Number(evaluation.result.value?.sy ?? 0)
				}
			} catch {}
			const xi = Math.max(0, Math.floor(curX + sx))
			const yi = Math.max(0, Math.floor(curY + sy))

			let res: { backendNodeId?: number; frameId?: string } | undefined
			try {
				res = await curSession.send("DOM.getNodeForLocation", {
					x: xi,
					y: yi,
					includeUserAgentShadowDOM: false,
					ignorePointerEventsNone: false,
				})
			} catch {
				return null
			}

			const be = res?.backendNodeId
			const reportedFrameId = res?.frameId
			if (
				typeof be === "number" &&
				reportedFrameId &&
				reportedFrameId !== curFrameId
			) {
				const abs = await buildAbsoluteXPathFromChain(
					iframeChain,
					curSession,
					be,
				)
				return abs
					? { frameId: reportedFrameId, backendNodeId: be, absoluteXPath: abs }
					: null
			}

			if (typeof be !== "number") {
				return null
			}

			let matchedChild: string | undefined
			for (const fid of listChildrenOf(parentByFrame, curFrameId)) {
				try {
					const { backendNodeId } = await curSession.send("DOM.getFrameOwner", {
						frameId: fid,
					})
					if (backendNodeId === be) {
						matchedChild = fid
						break
					}
				} catch {}
			}

			if (!matchedChild) {
				const abs = await buildAbsoluteXPathFromChain(
					iframeChain,
					curSession,
					be,
				)
				return abs
					? { frameId: curFrameId, backendNodeId: be, absoluteXPath: abs }
					: null
			}

			iframeChain.push({
				parentSession: curSession,
				iframeBackendNodeId: be,
			})

			let left = 0
			let top = 0
			let objectId: string | undefined
			try {
				const { object } = await curSession.send("DOM.resolveNode", {
					backendNodeId: be,
				})
				objectId = object?.objectId
				if (objectId) {
					const evaluation = await curSession.send("Runtime.callFunctionOn", {
						objectId,
						functionDeclaration: a11yScriptSources.getBoundingRectLite,
						returnByValue: true,
					})
					await releaseDiscardedEvaluationHandles(curSession, evaluation)
					if (!evaluation.exceptionDetails) {
						left = Number(evaluation.result.value?.left ?? 0)
						top = Number(evaluation.result.value?.top ?? 0)
					}
				}
			} catch {
			} finally {
				await releaseObjectIds(curSession, [objectId])
			}
			curX = Math.max(0, curX - left)
			curY = Math.max(0, curY - top)
			curFrameId = matchedChild
			curSession = page.getSessionForFrame(curFrameId)
		} catch {
			return null
		}
	}
	return null
}
