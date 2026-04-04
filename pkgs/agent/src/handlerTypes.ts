import type { Page } from "@handstage/core"
import type { InferToolInput, InferToolOutput } from "ai"
import type { handstagesAgentTools } from "./definitions"

type Tools = typeof handstagesAgentTools

/**
 * Inferred tool input/output types for the Handstages browser agent, e.g.
 * `HandstagesAgent.NewPageInput` / `HandstagesAgent.NewPageOutput`.
 */
export namespace HandstagesAgent {
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
	pages(input: HandstagesAgent.PagesInput): Promise<HandstagesAgent.PagesOutput>
	newPage(
		input: HandstagesAgent.NewPageInput,
	): Promise<HandstagesAgent.NewPageOutput>
	setActivePage(
		input: HandstagesAgent.SetActivePageInput,
	): Promise<HandstagesAgent.SetActivePageOutput>
	goto(input: HandstagesAgent.GotoInput): Promise<HandstagesAgent.GotoOutput>
	reload(
		input: HandstagesAgent.ReloadInput,
	): Promise<HandstagesAgent.ReloadOutput>
	goBack(
		input: HandstagesAgent.GoBackInput,
	): Promise<HandstagesAgent.GoBackOutput>
	goForward(
		input: HandstagesAgent.GoForwardInput,
	): Promise<HandstagesAgent.GoForwardOutput>
	snapshot(
		input: HandstagesAgent.SnapshotInput,
	): Promise<HandstagesAgent.SnapshotOutput>
	pageInfo(
		input: HandstagesAgent.PageInfoInput,
	): Promise<HandstagesAgent.PageInfoOutput>
	click(input: HandstagesAgent.ClickInput): Promise<HandstagesAgent.ClickOutput>
	hover(input: HandstagesAgent.HoverInput): Promise<HandstagesAgent.HoverOutput>
	scroll(
		input: HandstagesAgent.ScrollInput,
	): Promise<HandstagesAgent.ScrollOutput>
	type(input: HandstagesAgent.TypeInput): Promise<HandstagesAgent.TypeOutput>
	click_on(
		input: HandstagesAgent.ClickOnInput,
	): Promise<HandstagesAgent.ClickOnOutput>
	fill_on(
		input: HandstagesAgent.FillOnInput,
	): Promise<HandstagesAgent.FillOnOutput>
	type_on(
		input: HandstagesAgent.TypeOnInput,
	): Promise<HandstagesAgent.TypeOnOutput>
	hover_on(
		input: HandstagesAgent.HoverOnInput,
	): Promise<HandstagesAgent.HoverOnOutput>
}
