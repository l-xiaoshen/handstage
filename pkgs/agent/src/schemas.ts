import { z } from "zod"

export const LoadStateSchema = z
	.enum(["load", "domcontentloaded", "networkidle"])
	.optional()
	.describe("Wait until this lifecycle event (navigation / reload / history)")

export const PageIdSchema = z
	.string()
	.describe("Target id of the page tab (from pages or newPage)")

export const PagesInputSchema = z.object({})

export const NewPageInputSchema = z.object({
	url: z.string().optional().describe('Initial URL (default "about:blank")'),
})

export const SetActivePageInputSchema = z.object({ pageId: PageIdSchema })

export const GotoInputSchema = z.object({
	pageId: PageIdSchema,
	url: z.string().min(1),
	waitUntil: LoadStateSchema,
	timeoutMs: z.number().positive().optional(),
})

export const ReloadInputSchema = z.object({
	pageId: PageIdSchema,
	waitUntil: LoadStateSchema,
	timeoutMs: z.number().positive().optional(),
	ignoreCache: z.boolean().optional(),
})

export const GoBackInputSchema = z.object({
	pageId: PageIdSchema,
	waitUntil: LoadStateSchema,
	timeoutMs: z.number().positive().optional(),
})

export const GoForwardInputSchema = z.object({
	pageId: PageIdSchema,
	waitUntil: LoadStateSchema,
	timeoutMs: z.number().positive().optional(),
})

export const SnapshotInputSchema = z.object({
	pageId: PageIdSchema,
	includeIframes: z.boolean().optional(),
})

export const PageInfoInputSchema = z.object({ pageId: PageIdSchema })

export const ClickInputSchema = z.object({
	pageId: PageIdSchema,
	x: z.number(),
	y: z.number(),
	button: z.enum(["left", "right", "middle"]).optional(),
	clickCount: z.number().int().positive().optional(),
})

export const HoverInputSchema = z.object({
	pageId: PageIdSchema,
	x: z.number(),
	y: z.number(),
})

export const ScrollInputSchema = z.object({
	pageId: PageIdSchema,
	x: z.number(),
	y: z.number(),
	deltaX: z.number(),
	deltaY: z.number(),
})

export const TypeInputSchema = z.object({
	pageId: PageIdSchema,
	text: z.string(),
	delay: z.number().nonnegative().optional(),
	withMistakes: z.boolean().optional(),
})

export const ClickOnInputSchema = z.object({
	pageId: PageIdSchema,
	select: z
		.string()
		.min(1)
		.describe("CSS selector or XPath (e.g. //button[@id='x'])"),
})

export const FillOnInputSchema = z.object({
	pageId: PageIdSchema,
	select: z.string().min(1).describe("CSS selector or XPath"),
	value: z.string(),
})

export const TypeOnInputSchema = z.object({
	pageId: PageIdSchema,
	select: z.string().min(1).describe("CSS selector or XPath"),
	text: z.string(),
	delay: z.number().nonnegative().optional(),
})

export const HoverOnInputSchema = z.object({
	pageId: PageIdSchema,
	select: z.string().min(1).describe("CSS selector or XPath"),
})

/** Shared `{ ok: true } | { ok: false; error }` tool result shape */
export const HandstagesAgentOkOrErrOutputSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true) }),
	z.object({ ok: z.literal(false), error: z.string() }),
])

export const HandstagesAgentPageEntrySchema = z.object({
	pageId: z.string(),
	url: z.string(),
	title: z.string(),
	activated: z.boolean(),
})

export const PagesOutputSchema = z.object({
	pages: z.array(HandstagesAgentPageEntrySchema),
})

export const NewPageOutputSchema = z.object({ pageId: z.string() })

export const SetActivePageOutputSchema = HandstagesAgentOkOrErrOutputSchema

export const GotoOutputSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true), url: z.string() }),
	z.object({ ok: z.literal(false), error: z.string() }),
])

export const ReloadOutputSchema = GotoOutputSchema

export const HistoryNavOutputSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		navigated: z.boolean(),
		url: z.string(),
	}),
	z.object({ ok: z.literal(false), error: z.string() }),
])

export const SnapshotOutputSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		tree: z.string(),
		xpathMap: z.record(z.string(), z.string()),
		urlMap: z.record(z.string(), z.string()),
	}),
	z.object({ ok: z.literal(false), error: z.string() }),
])

export const PageInfoOutputSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		url: z.string(),
		title: z.string(),
	}),
	z.object({ ok: z.literal(false), error: z.string() }),
])

export const PointerOutputSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		xpathAtPoint: z.string().optional(),
	}),
	z.object({ ok: z.literal(false), error: z.string() }),
])

export const TypeOutputSchema = HandstagesAgentOkOrErrOutputSchema

export const ElementActionOutputSchema = HandstagesAgentOkOrErrOutputSchema
