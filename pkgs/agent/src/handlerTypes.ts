import type { Page } from "@handstage/core"
import type { InferToolInput, InferToolOutput } from "ai"
import type { handstageAgentTools } from "./definitions"

type Tools = typeof handstageAgentTools

/**
 * Inferred tool input/output types for the Handstage browser agent, e.g.
 * `HandstageAgent.NewPageInput` / `HandstageAgent.NewPageOutput`.
 */
export namespace HandstageAgent {
	export type ToolName = keyof Tools

	export type PagesInput = InferToolInput<Tools["pages"]>
	export type PagesOutput = InferToolOutput<Tools["pages"]>
	export type PageEntry = PagesOutput["pages"][number]

	export type NewPageInput = InferToolInput<Tools["newPage"]>
	export type NewPageOutput = InferToolOutput<Tools["newPage"]>

	export type SetActivePageInput = InferToolInput<Tools["setActivePage"]>
	export type SetActivePageOutput = InferToolOutput<Tools["setActivePage"]>

	export type GotoInput = InferToolInput<Tools["goto"]>
	export type GotoOutput = InferToolOutput<Tools["goto"]>

	export type ReloadInput = InferToolInput<Tools["reload"]>
	export type ReloadOutput = InferToolOutput<Tools["reload"]>

	export type GoBackInput = InferToolInput<Tools["goBack"]>
	export type GoBackOutput = InferToolOutput<Tools["goBack"]>

	export type GoForwardInput = InferToolInput<Tools["goForward"]>
	export type GoForwardOutput = InferToolOutput<Tools["goForward"]>

	export type SnapshotInput = InferToolInput<Tools["snapshot"]>
	export type SnapshotOutput = InferToolOutput<Tools["snapshot"]>

	export type PageInfoInput = InferToolInput<Tools["pageInfo"]>
	export type PageInfoOutput = InferToolOutput<Tools["pageInfo"]>

	export type ClickInput = InferToolInput<Tools["click"]>
	export type ClickOutput = InferToolOutput<Tools["click"]>

	export type HoverInput = InferToolInput<Tools["hover"]>
	export type HoverOutput = InferToolOutput<Tools["hover"]>

	export type ScrollInput = InferToolInput<Tools["scroll"]>
	export type ScrollOutput = InferToolOutput<Tools["scroll"]>

	export type TypeInput = InferToolInput<Tools["type"]>
	export type TypeOutput = InferToolOutput<Tools["type"]>

	export type ClickOnInput = InferToolInput<Tools["click_on"]>
	export type ClickOnOutput = InferToolOutput<Tools["click_on"]>

	export type FillOnInput = InferToolInput<Tools["fill_on"]>
	export type FillOnOutput = InferToolOutput<Tools["fill_on"]>

	export type TypeOnInput = InferToolInput<Tools["type_on"]>
	export type TypeOnOutput = InferToolOutput<Tools["type_on"]>

	export type HoverOnInput = InferToolInput<Tools["hover_on"]>
	export type HoverOnOutput = InferToolOutput<Tools["hover_on"]>

	export type OkResult = Extract<SetActivePageOutput, { ok: true }>
	export type ErrResult = Extract<SetActivePageOutput, { ok: false }>
}

/**
 * Browser context exposed by Handstage (`V3.context` after init). Implementations
 * of {@link HandstageAgentToolHandlers} typically hold this.
 */
export interface HandstageAgentContext {
	pages(): Page[]
	activePage(): Page | undefined
	setActivePage(page: Page): void
	newPage(url?: string): Promise<Page>
}

/**
 * Implementations perform Handstage actions for each tool. Inputs and outputs are
 * inferred from {@link handstageAgentTools} via the AI SDK.
 */
export interface HandstageAgentToolHandlers {
	pages(input: HandstageAgent.PagesInput): Promise<HandstageAgent.PagesOutput>
	newPage(
		input: HandstageAgent.NewPageInput,
	): Promise<HandstageAgent.NewPageOutput>
	setActivePage(
		input: HandstageAgent.SetActivePageInput,
	): Promise<HandstageAgent.SetActivePageOutput>
	goto(input: HandstageAgent.GotoInput): Promise<HandstageAgent.GotoOutput>
	reload(
		input: HandstageAgent.ReloadInput,
	): Promise<HandstageAgent.ReloadOutput>
	goBack(
		input: HandstageAgent.GoBackInput,
	): Promise<HandstageAgent.GoBackOutput>
	goForward(
		input: HandstageAgent.GoForwardInput,
	): Promise<HandstageAgent.GoForwardOutput>
	snapshot(
		input: HandstageAgent.SnapshotInput,
	): Promise<HandstageAgent.SnapshotOutput>
	pageInfo(
		input: HandstageAgent.PageInfoInput,
	): Promise<HandstageAgent.PageInfoOutput>
	click(input: HandstageAgent.ClickInput): Promise<HandstageAgent.ClickOutput>
	hover(input: HandstageAgent.HoverInput): Promise<HandstageAgent.HoverOutput>
	scroll(
		input: HandstageAgent.ScrollInput,
	): Promise<HandstageAgent.ScrollOutput>
	type(input: HandstageAgent.TypeInput): Promise<HandstageAgent.TypeOutput>
	click_on(
		input: HandstageAgent.ClickOnInput,
	): Promise<HandstageAgent.ClickOnOutput>
	fill_on(
		input: HandstageAgent.FillOnInput,
	): Promise<HandstageAgent.FillOnOutput>
	type_on(
		input: HandstageAgent.TypeOnInput,
	): Promise<HandstageAgent.TypeOnOutput>
	hover_on(
		input: HandstageAgent.HoverOnInput,
	): Promise<HandstageAgent.HoverOnOutput>
}
