import { a11yScriptSources } from "@handstage/dom/build/a11yScripts.generated"
import type { Protocol } from "devtools-protocol"
import { buildA11yInvocation } from "../../a11yInvocation"
import { executionContexts } from "../../executionContextRegistry"
import type { Page } from "../../page"
import {
	releaseDiscardedEvaluationHandles,
	releaseObjectIds,
} from "../../runtimeObjectUtils"
import {
	absoluteXPathForBackendNode,
	normalizeXPath,
	prefixXPath,
} from "./xpathUtils"

/**
 * Compute the absolute XPath for the currently focused element.
 * - Detects which frame has focus via document.hasFocus().
 * - Finds the deepest activeElement (dives into shadow DOM).
 * - Builds an absolute, cross-frame XPath by prefixing iframe hosts.
 */
export async function computeActiveElementXpath(
	page: Page,
): Promise<string | null> {
	const tree = page.getFullFrameTree()
	const parentByFrame = new Map<string, string | null>()
	;(function index(n: Protocol.Page.FrameTree, parent: string | null) {
		parentByFrame.set(n.frame.id, parent)
		for (const c of n.childFrames ?? []) {
			index(c, n.frame.id)
		}
	})(tree, null)

	const frames = page.listAllFrameIds()
	let focusedFrameId: string | null = null
	for (const fid of frames) {
		const sess = page.getSessionForFrame(fid)
		try {
			await sess.send("Runtime.enable").catch(() => {})
			const ctxId = await executionContexts
				.waitForMainWorld(sess, fid, 1000)
				.catch(() => {})
			const hasFocusExpr = buildA11yInvocation("documentHasFocusStrict", [])
			const evalParams = ctxId
				? {
						contextId: ctxId,
						expression: hasFocusExpr,
						returnByValue: true,
					}
				: { expression: hasFocusExpr, returnByValue: true }
			const evaluation = await sess.send("Runtime.evaluate", evalParams)
			await releaseDiscardedEvaluationHandles(sess, evaluation)
			if (!evaluation.exceptionDetails && evaluation.result.value === true) {
				focusedFrameId = fid
				break
			}
		} catch {}
	}
	if (!focusedFrameId) {
		focusedFrameId = page.mainFrameId()
	}
	const focusedSession = page.getSessionForFrame(focusedFrameId)

	let objectId: string | undefined
	try {
		await focusedSession.send("Runtime.enable").catch(() => {})
		const ctxId = await executionContexts
			.waitForMainWorld(focusedSession, focusedFrameId, 1000)
			.catch(() => {})
		const activeExpr = buildA11yInvocation("resolveDeepActiveElement", [])
		const evalParams = ctxId
			? {
					contextId: ctxId,
					expression: activeExpr,
					returnByValue: false,
				}
			: { expression: activeExpr, returnByValue: false }
		const evaluation = await focusedSession.send("Runtime.evaluate", evalParams)
		if (evaluation.exceptionDetails) {
			await releaseDiscardedEvaluationHandles(focusedSession, evaluation)
		} else {
			objectId = evaluation.result.objectId
		}
	} catch {
		objectId = undefined
	}
	if (!objectId) {
		return null
	}

	const leafXPath = await (async () => {
		try {
			const evaluation = await focusedSession.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: a11yScriptSources.nodeToAbsoluteXPath,
				returnByValue: true,
			})
			await releaseDiscardedEvaluationHandles(focusedSession, evaluation)
			if (evaluation.exceptionDetails) {
				return null
			}
			const xp = evaluation.result.value || ""
			return typeof xp === "string" && xp ? xp : null
		} catch {
			return null
		} finally {
			await releaseObjectIds(focusedSession, [objectId])
		}
	})()

	if (!leafXPath) {
		return null
	}

	let prefix = ""
	let cur: string | null | undefined = focusedFrameId
	while (cur) {
		const parent: string | null = parentByFrame.get(cur) ?? null
		if (!parent) {
			break
		}
		const parentSess = page.getSessionForFrame(parent)
		try {
			const { backendNodeId } = await parentSess.send("DOM.getFrameOwner", {
				frameId: cur,
			})
			if (typeof backendNodeId === "number") {
				const xp = await absoluteXPathForBackendNode(parentSess, backendNodeId)
				if (xp) {
					prefix = prefix ? prefixXPath(prefix, xp) : normalizeXPath(xp)
				}
			}
		} catch {}
		cur = parent
	}

	return prefix ? prefixXPath(prefix, leafXPath) : normalizeXPath(leafXPath)
}
