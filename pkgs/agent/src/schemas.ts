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

export const BringToFrontInputSchema = z.object({ pageId: PageIdSchema })

export const ClosePageInputSchema = z.object({ pageId: PageIdSchema })

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

export const SnapshotDomInputSchema = z.object({
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

/** Encoded node id from snapshot_dom (e.g. `1-42` — frameOrdinal-backendNodeId). */
export const A11yEncodedIdSchema = z
	.string()
	.min(1)
	.regex(/^\d+-\d+$/, "Expected frameOrdinal-backendNodeId from snapshot_dom")
	.describe("Encoded node id from snapshot_dom (bracketed id in the a11y tree)")

export const ClickOnIdInputSchema = z.object({
	pageId: PageIdSchema,
	id: A11yEncodedIdSchema,
})

export const FillOnIdInputSchema = z.object({
	pageId: PageIdSchema,
	id: A11yEncodedIdSchema,
	value: z.string(),
})

export const TypeOnIdInputSchema = z.object({
	pageId: PageIdSchema,
	id: A11yEncodedIdSchema,
	text: z.string(),
	delay: z.number().nonnegative().optional(),
})

export const HoverOnIdInputSchema = z.object({
	pageId: PageIdSchema,
	id: A11yEncodedIdSchema,
})

/** Shared `{ ok: true } | { ok: false; error }` tool result shape */
export const HandstageAgentOkOrErrOutputSchema = z.discriminatedUnion("ok", [
	z.object({ ok: z.literal(true) }),
	z.object({ ok: z.literal(false), error: z.string() }),
])

export const HandstageAgentPageEntrySchema = z.object({
	pageId: z.string(),
	url: z.string(),
	title: z.string(),
})

export const PagesOutputSchema = z.object({
	pages: z.array(HandstageAgentPageEntrySchema),
})

export const NewPageOutputSchema = z.object({ pageId: z.string() })

export const BringToFrontOutputSchema = HandstageAgentOkOrErrOutputSchema

export const ClosePageOutputSchema = HandstageAgentOkOrErrOutputSchema

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

export const SnapshotDomOutputSchema = z.discriminatedUnion("ok", [
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

export const TypeOutputSchema = HandstageAgentOkOrErrOutputSchema

export const ElementActionOutputSchema = HandstageAgentOkOrErrOutputSchema
