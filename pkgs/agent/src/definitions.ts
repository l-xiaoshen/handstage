import { type ToolSet, tool } from "ai"
import type { HandstageAgentToolHandlers } from "./handlerTypes"
import {
	// ClickInputSchema,
	ClickOnIdInputSchema,
	// BringToFrontInputSchema,
	// BringToFrontOutputSchema,
	ClosePageInputSchema,
	ClosePageOutputSchema,
	// ClickOnInputSchema,
	ElementActionOutputSchema,
	FillOnIdInputSchema,
	// FillOnInputSchema,
	GoBackInputSchema,
	GoForwardInputSchema,
	GotoInputSchema,
	GotoOutputSchema,
	HistoryNavOutputSchema,
	// HoverInputSchema,
	HoverOnIdInputSchema,
	// HoverOnInputSchema,
	NewPageInputSchema,
	NewPageOutputSchema,
	// PageInfoInputSchema,
	// PageInfoOutputSchema,
	PagesInputSchema,
	PagesOutputSchema,
	// PointerOutputSchema,
	ReloadInputSchema,
	ReloadOutputSchema,
	// ScrollInputSchema,
	SnapshotDomInputSchema,
	SnapshotDomOutputSchema,
	// TypeInputSchema,
	TypeOnIdInputSchema,
} from "./schemas"

export type HandstageAgentToolSet = ReturnType<
	typeof createHandstageAgentToolDefinitions
>

function pagesToXml(
	pages: Array<{ pageId: string; url: string; title: string }>,
): string {
	return `<pages>\n${pages
		.map(
			(page) =>
				`<page>\n<pageId>${page.pageId}</pageId>\n<url>${page.url}</url>\n<title>${page.title}</title>\n</page>`,
		)
		.join("\n")}\n</pages>`
}

/**
 * Same object as {@link handstageAgentTools}; kept for callers that only need a `ToolSet`.
 */
export function createHandstageAgentToolDefinitions(
	handler: HandstageAgentToolHandlers,
) {
	const tools = {
		pages: tool({
			description:
				"List opend pages in current browser context. Each entry has pageId, url, and title. Pages are returned in the order they were opened; no tab is implicitly 'active' — pass the pageId you want to act on with every tool call.",
			inputSchema: PagesInputSchema,
			outputSchema: PagesOutputSchema,
			toModelOutput: ({ output }) => {
				return {
					type: "text",
					value: pagesToXml(output.pages),
				}
			},
			execute: async (input) => {
				return await handler.pages(input)
			},
		}),

		newPage: tool({
			description:
				"Open a new browser page. Returns the new page's pageId. Optional starting URL (defaults to about:blank).",
			inputSchema: NewPageInputSchema,
			outputSchema: NewPageOutputSchema,
			execute: async (input) => {
				return await handler.newPage(input)
			},
		}),

		closePage: tool({
			description: "Close a browser page by pageId.",
			inputSchema: ClosePageInputSchema,
			outputSchema: ClosePageOutputSchema,
			execute: async (input) => {
				return await handler.closePage(input)
			},
		}),

		// bringToFront: tool({
		// 	description:
		// 		"Foreground a tab by pageId (Target.activateTarget). Necessary before input events can land on that tab in headful Chrome.",
		// 	inputSchema: BringToFrontInputSchema,
		// 	outputSchema: BringToFrontOutputSchema,
		// }),

		goto: tool({
			description: "Navigate a page to a URL.",
			inputSchema: GotoInputSchema,
			outputSchema: GotoOutputSchema,
			execute: async (input) => {
				return await handler.goto(input)
			},
		}),

		reload: tool({
			description: "Reload the current document in a page.",
			inputSchema: ReloadInputSchema,
			outputSchema: ReloadOutputSchema,
			execute: async (input) => {
				return await handler.reload(input)
			},
		}),

		goBack: tool({
			description: "Go back in history for a page, if possible.",
			inputSchema: GoBackInputSchema,
			outputSchema: HistoryNavOutputSchema,
			execute: async (input) => {
				return await handler.goBack(input)
			},
		}),

		goForward: tool({
			description: "Go forward in history for a page, if possible.",
			inputSchema: GoForwardInputSchema,
			outputSchema: HistoryNavOutputSchema,
			execute: async (input) => {
				return await handler.goForward(input)
			},
		}),

		snapshot_dom: tool({
			description:
				"Accessibility tree for a page (pageId). Multiline outline with encoded node ids in brackets (e.g. [1-42]); use those ids with click_on_id, fill_on_id, type_on_id, or hover_on_id.",
			inputSchema: SnapshotDomInputSchema,
			outputSchema: SnapshotDomOutputSchema,
			toModelOutput: ({ output }) => {
				if (output.ok) {
					return {
						type: "text",
						value: output.tree,
					}
				}
				return {
					type: "text",
					value: output.error,
				}
			},
			execute: async (input) => {
				return await handler.snapshot_dom(input)
			},
		}),

		// pageInfo: tool({
		// 	description: "Current URL and document title for a page.",
		// 	inputSchema: PageInfoInputSchema,
		// 	outputSchema: PageInfoOutputSchema,
		// }),

		// click: tool({
		// 	description:
		// 		"Click at viewport coordinates (CSS pixels). Does not scroll; ensure the target is visible.",
		// 	inputSchema: ClickInputSchema,
		// 	outputSchema: PointerOutputSchema,
		// }),

		// hover: tool({
		// 	description: "Move the pointer to viewport coordinates (CSS pixels).",
		// 	inputSchema: HoverInputSchema,
		// 	outputSchema: PointerOutputSchema,
		// }),

		// scroll: tool({
		// 	description:
		// 		"Dispatch a mouse wheel at viewport coordinates (deltaX/deltaY in pixels).",
		// 	inputSchema: ScrollInputSchema,
		// 	outputSchema: PointerOutputSchema,
		// }),

		// type: tool({
		// 	description:
		// 		"Type text using key events at the current focus. Focus an input first (e.g. click_on_id) or tab to it.",
		// 	inputSchema: TypeInputSchema,
		// 	outputSchema: TypeOutputSchema,
		// }),

		// click_on: tool({
		// 	description:
		// 		"Click the first element matching a CSS or XPath selector in the page's main frame.",
		// 	inputSchema: ClickOnInputSchema,
		// 	outputSchema: ElementActionOutputSchema,
		// }),

		// fill_on: tool({
		// 	description:
		// 		"Clear and fill an input element matched by a CSS or XPath selector (main frame).",
		// 	inputSchema: FillOnInputSchema,
		// 	outputSchema: ElementActionOutputSchema,
		// }),

		// type_on: tool({
		// 	description:
		// 		"Type into an element matched by a CSS or XPath selector (focuses the element first).",
		// 	inputSchema: TypeOnInputSchema,
		// 	outputSchema: ElementActionOutputSchema,
		// }),

		// hover_on: tool({
		// 	description:
		// 		"Hover the first element matching a CSS or XPath selector in the page's main frame.",
		// 	inputSchema: HoverOnInputSchema,
		// 	outputSchema: ElementActionOutputSchema,
		// }),

		click_on_id: tool({
			description:
				"Click the element for an encoded accessibility tree node id from snapshot_dom.",
			inputSchema: ClickOnIdInputSchema,
			outputSchema: ElementActionOutputSchema,
			execute: async (input) => {
				return await handler.click_on_id(input)
			},
		}),

		fill_on_id: tool({
			description:
				"Clear and fill an input for an encoded accessibility tree node id from snapshot_dom.",
			inputSchema: FillOnIdInputSchema,
			outputSchema: ElementActionOutputSchema,
			execute: async (input) => {
				return await handler.fill_on_id(input)
			},
		}),

		type_on_id: tool({
			description:
				"Type into an element for an encoded accessibility tree node id from snapshot_dom.",
			inputSchema: TypeOnIdInputSchema,
			outputSchema: ElementActionOutputSchema,
			execute: async (input) => {
				return await handler.type_on_id(input)
			},
		}),

		hover_on_id: tool({
			description:
				"Hover the element for an encoded accessibility tree node id from snapshot_dom.",
			inputSchema: HoverOnIdInputSchema,
			outputSchema: ElementActionOutputSchema,
			execute: async (input) => {
				return await handler.hover_on_id(input)
			},
		}),
	} as const satisfies ToolSet

	return tools
}
