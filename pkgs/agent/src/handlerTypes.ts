import type { Page } from "@handstage/core"
import type { InferToolInput, InferToolOutput } from "ai"
import type { handstagesAgentTools } from "./definitions"

type Tools = typeof handstagesAgentTools

/**
 * Inferred tool input/output types for the Handstages browser agent, grouped by
 * namespace so call sites can use e.g. `HandstagesAgent.Input.NewPage` instead of
 * long prefixed type names.
 */
export namespace HandstagesAgent {
	export type ToolName = keyof Tools

	export namespace Input {
		export type Pages = InferToolInput<Tools["pages"]>
		export type NewPage = InferToolInput<Tools["newPage"]>
		export type SetActivePage = InferToolInput<Tools["setActivePage"]>
		export type Goto = InferToolInput<Tools["goto"]>
		export type Reload = InferToolInput<Tools["reload"]>
		export type GoBack = InferToolInput<Tools["goBack"]>
		export type GoForward = InferToolInput<Tools["goForward"]>
		export type Snapshot = InferToolInput<Tools["snapshot"]>
		export type PageInfo = InferToolInput<Tools["pageInfo"]>
		export type Click = InferToolInput<Tools["click"]>
		export type Hover = InferToolInput<Tools["hover"]>
		export type Scroll = InferToolInput<Tools["scroll"]>
		/** Input for the `type` tool (keyboard text entry). */
		export type Type = InferToolInput<Tools["type"]>
		export type ClickOn = InferToolInput<Tools["click_on"]>
		export type FillOn = InferToolInput<Tools["fill_on"]>
		export type TypeOn = InferToolInput<Tools["type_on"]>
		export type HoverOn = InferToolInput<Tools["hover_on"]>
	}

	export namespace Output {
		export type Pages = InferToolOutput<Tools["pages"]>
		export type PageEntry = Pages["pages"][number]
		export type NewPage = InferToolOutput<Tools["newPage"]>
		export type SetActivePage = InferToolOutput<Tools["setActivePage"]>
		export type Goto = InferToolOutput<Tools["goto"]>
		export type Reload = InferToolOutput<Tools["reload"]>
		export type HistoryNav = InferToolOutput<Tools["goBack"]>
		export type Snapshot = InferToolOutput<Tools["snapshot"]>
		export type PageInfo = InferToolOutput<Tools["pageInfo"]>
		/** Result for click, hover, and scroll pointer tools. */
		export type Pointer = InferToolOutput<Tools["click"]>
		/** Result for the `type` tool. */
		export type Type = InferToolOutput<Tools["type"]>
		/** Result for click_on, fill_on, type_on, hover_on. */
		export type ElementAction = InferToolOutput<Tools["click_on"]>
	}

	export type OkResult = Extract<Output.SetActivePage, { ok: true }>
	export type ErrResult = Extract<Output.SetActivePage, { ok: false }>
}

/**
 * Browser context exposed by Handstages (`V3.context` after init). Implementations
 * of {@link HandstagesAgentToolHandlers} typically hold this.
 */
export interface HandstagesAgentContext {
	pages(): Page[]
	activePage(): Page | undefined
	setActivePage(page: Page): void
	newPage(url?: string): Promise<Page>
}

/**
 * Implementations perform Handstages actions for each tool. Inputs and outputs are
 * inferred from {@link handstagesAgentTools} via the AI SDK.
 */
export interface HandstagesAgentToolHandlers {
	pages(
		input: HandstagesAgent.Input.Pages,
	): Promise<HandstagesAgent.Output.Pages>
	newPage(
		input: HandstagesAgent.Input.NewPage,
	): Promise<HandstagesAgent.Output.NewPage>
	setActivePage(
		input: HandstagesAgent.Input.SetActivePage,
	): Promise<HandstagesAgent.Output.SetActivePage>
	goto(input: HandstagesAgent.Input.Goto): Promise<HandstagesAgent.Output.Goto>
	reload(
		input: HandstagesAgent.Input.Reload,
	): Promise<HandstagesAgent.Output.Reload>
	goBack(
		input: HandstagesAgent.Input.GoBack,
	): Promise<HandstagesAgent.Output.HistoryNav>
	goForward(
		input: HandstagesAgent.Input.GoForward,
	): Promise<HandstagesAgent.Output.HistoryNav>
	snapshot(
		input: HandstagesAgent.Input.Snapshot,
	): Promise<HandstagesAgent.Output.Snapshot>
	pageInfo(
		input: HandstagesAgent.Input.PageInfo,
	): Promise<HandstagesAgent.Output.PageInfo>
	click(
		input: HandstagesAgent.Input.Click,
	): Promise<HandstagesAgent.Output.Pointer>
	hover(
		input: HandstagesAgent.Input.Hover,
	): Promise<HandstagesAgent.Output.Pointer>
	scroll(
		input: HandstagesAgent.Input.Scroll,
	): Promise<HandstagesAgent.Output.Pointer>
	type(input: HandstagesAgent.Input.Type): Promise<HandstagesAgent.Output.Type>
	click_on(
		input: HandstagesAgent.Input.ClickOn,
	): Promise<HandstagesAgent.Output.ElementAction>
	fill_on(
		input: HandstagesAgent.Input.FillOn,
	): Promise<HandstagesAgent.Output.ElementAction>
	type_on(
		input: HandstagesAgent.Input.TypeOn,
	): Promise<HandstagesAgent.Output.ElementAction>
	hover_on(
		input: HandstagesAgent.Input.HoverOn,
	): Promise<HandstagesAgent.Output.ElementAction>
}
