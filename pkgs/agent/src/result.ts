import type { Page, V3Context } from "@handstage/core"
import type { ErrResult } from "./types"

export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function errResult(error: string): ErrResult {
	return { ok: false, error }
}

export async function tryAgentResult<T extends Record<string, unknown>>(
	fn: () => Promise<T>,
): Promise<({ ok: true } & T) | ErrResult> {
	try {
		const data = await fn()
		return { ok: true, ...data }
	} catch (error) {
		return errResult(formatError(error))
	}
}

export async function withPage<T extends Record<string, unknown>>(
	ctx: V3Context,
	pageId: string,
	fn: (page: Page) => Promise<T>,
): Promise<({ ok: true } & T) | ErrResult> {
	const page = ctx.resolvePageByTargetId(pageId)
	if (!page) return errResult(`Unknown pageId: ${pageId}`)
	return tryAgentResult(() => fn(page))
}
