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

export type PagesInput = z.infer<typeof PagesInputSchema>
export type NewPageInput = z.infer<typeof NewPageInputSchema>
export type SetActivePageInput = z.infer<typeof SetActivePageInputSchema>
export type GotoInput = z.infer<typeof GotoInputSchema>
export type ReloadInput = z.infer<typeof ReloadInputSchema>
export type GoBackInput = z.infer<typeof GoBackInputSchema>
export type GoForwardInput = z.infer<typeof GoForwardInputSchema>
export type SnapshotInput = z.infer<typeof SnapshotInputSchema>
export type PageInfoInput = z.infer<typeof PageInfoInputSchema>
export type ClickInput = z.infer<typeof ClickInputSchema>
export type HoverInput = z.infer<typeof HoverInputSchema>
export type ScrollInput = z.infer<typeof ScrollInputSchema>
export type TypeInput = z.infer<typeof TypeInputSchema>
export type ClickOnInput = z.infer<typeof ClickOnInputSchema>
export type FillOnInput = z.infer<typeof FillOnInputSchema>
export type TypeOnInput = z.infer<typeof TypeOnInputSchema>
export type HoverOnInput = z.infer<typeof HoverOnInputSchema>
