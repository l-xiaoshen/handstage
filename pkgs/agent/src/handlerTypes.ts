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

export type HandstagesAgentToolName = HandstagesAgent.ToolName

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

/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.Pages`. */
export type HandstagesAgentPagesInput = HandstagesAgent.Input.Pages
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.NewPage`. */
export type HandstagesAgentNewPageInput = HandstagesAgent.Input.NewPage
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.SetActivePage`. */
export type HandstagesAgentSetActivePageInput =
	HandstagesAgent.Input.SetActivePage
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.Goto`. */
export type HandstagesAgentGotoInput = HandstagesAgent.Input.Goto
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.Reload`. */
export type HandstagesAgentReloadInput = HandstagesAgent.Input.Reload
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.GoBack`. */
export type HandstagesAgentGoBackInput = HandstagesAgent.Input.GoBack
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.GoForward`. */
export type HandstagesAgentGoForwardInput = HandstagesAgent.Input.GoForward
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.Snapshot`. */
export type HandstagesAgentSnapshotInput = HandstagesAgent.Input.Snapshot
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.PageInfo`. */
export type HandstagesAgentPageInfoInput = HandstagesAgent.Input.PageInfo
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.Click`. */
export type HandstagesAgentClickInput = HandstagesAgent.Input.Click
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.Hover`. */
export type HandstagesAgentHoverInput = HandstagesAgent.Input.Hover
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.Scroll`. */
export type HandstagesAgentScrollInput = HandstagesAgent.Input.Scroll
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.Type`. */
export type HandstagesAgentTypeInput = HandstagesAgent.Input.Type
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.ClickOn`. */
export type HandstagesAgentClickOnInput = HandstagesAgent.Input.ClickOn
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.FillOn`. */
export type HandstagesAgentFillOnInput = HandstagesAgent.Input.FillOn
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.TypeOn`. */
export type HandstagesAgentTypeOnInput = HandstagesAgent.Input.TypeOn
/** @deprecated Use {@link HandstagesAgent.Input} or `HandstagesAgent.Input.HoverOn`. */
export type HandstagesAgentHoverOnInput = HandstagesAgent.Input.HoverOn

/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.Pages`. */
export type HandstagesAgentPagesOutput = HandstagesAgent.Output.Pages
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.NewPage`. */
export type HandstagesAgentNewPageOutput = HandstagesAgent.Output.NewPage
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.SetActivePage`. */
export type HandstagesAgentSetActivePageOutput =
	HandstagesAgent.Output.SetActivePage
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.Goto`. */
export type HandstagesAgentGotoOutput = HandstagesAgent.Output.Goto
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.Reload`. */
export type HandstagesAgentReloadOutput = HandstagesAgent.Output.Reload
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.HistoryNav`. */
export type HandstagesAgentHistoryNavOutput = HandstagesAgent.Output.HistoryNav
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.Snapshot`. */
export type HandstagesAgentSnapshotOutput = HandstagesAgent.Output.Snapshot
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.PageInfo`. */
export type HandstagesAgentPageInfoOutput = HandstagesAgent.Output.PageInfo
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.Pointer`. */
export type HandstagesAgentPointerOutput = HandstagesAgent.Output.Pointer
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.Type`. */
export type HandstagesAgentTypeOutput = HandstagesAgent.Output.Type
/** @deprecated Use {@link HandstagesAgent.Output} or `HandstagesAgent.Output.ElementAction`. */
export type HandstagesAgentElementActionOutput =
	HandstagesAgent.Output.ElementAction

/** @deprecated Use {@link HandstagesAgent.Output.PageEntry}. */
export type HandstagesAgentPageEntry = HandstagesAgent.Output.PageEntry
/** @deprecated Use {@link HandstagesAgent.OkResult}. */
export type HandstagesAgentOkResult = HandstagesAgent.OkResult
/** @deprecated Use {@link HandstagesAgent.ErrResult}. */
export type HandstagesAgentErrResult = HandstagesAgent.ErrResult

/** Short aliases; prefer `HandstagesAgent.Input.*` for clarity in larger codebases. */
export type PagesInput = HandstagesAgent.Input.Pages
export type NewPageInput = HandstagesAgent.Input.NewPage
export type SetActivePageInput = HandstagesAgent.Input.SetActivePage
export type GotoInput = HandstagesAgent.Input.Goto
export type ReloadInput = HandstagesAgent.Input.Reload
export type GoBackInput = HandstagesAgent.Input.GoBack
export type GoForwardInput = HandstagesAgent.Input.GoForward
export type SnapshotInput = HandstagesAgent.Input.Snapshot
export type PageInfoInput = HandstagesAgent.Input.PageInfo
export type ClickInput = HandstagesAgent.Input.Click
export type HoverInput = HandstagesAgent.Input.Hover
export type ScrollInput = HandstagesAgent.Input.Scroll
/** Input for the `type` tool (keyboard text entry). */
export type TypeInput = HandstagesAgent.Input.Type
export type ClickOnInput = HandstagesAgent.Input.ClickOn
export type FillOnInput = HandstagesAgent.Input.FillOn
export type TypeOnInput = HandstagesAgent.Input.TypeOn
export type HoverOnInput = HandstagesAgent.Input.HoverOn

/** Short aliases for outputs; prefer `HandstagesAgent.Output.*` when grouping imports. */
export type PagesOutput = HandstagesAgent.Output.Pages
export type NewPageOutput = HandstagesAgent.Output.NewPage
export type SetActivePageOutput = HandstagesAgent.Output.SetActivePage
export type GotoOutput = HandstagesAgent.Output.Goto
export type ReloadOutput = HandstagesAgent.Output.Reload
export type HistoryNavOutput = HandstagesAgent.Output.HistoryNav
export type SnapshotOutput = HandstagesAgent.Output.Snapshot
export type PageInfoOutput = HandstagesAgent.Output.PageInfo
export type PointerOutput = HandstagesAgent.Output.Pointer
/** Result of the `type` tool. */
export type TypeOutput = HandstagesAgent.Output.Type
export type ElementActionOutput = HandstagesAgent.Output.ElementAction
export type PageEntry = HandstagesAgent.Output.PageEntry
