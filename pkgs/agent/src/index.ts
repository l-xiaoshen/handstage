export {
	createHandstagesAgentToolDefinitions,
	handstagesAgentTools,
} from "./definitions"
/** @deprecated Use `HandstagesAgent*Input` types from `./handlerTypes` (AI SDK inference). */
export type {
	HandstagesAgentClickInput as ClickInput,
	HandstagesAgentClickOnInput as ClickOnInput,
	HandstagesAgentFillOnInput as FillOnInput,
	HandstagesAgentGoBackInput as GoBackInput,
	HandstagesAgentGoForwardInput as GoForwardInput,
	HandstagesAgentGotoInput as GotoInput,
	HandstagesAgentHoverInput as HoverInput,
	HandstagesAgentHoverOnInput as HoverOnInput,
	HandstagesAgentNewPageInput as NewPageInput,
	HandstagesAgentPageInfoInput as PageInfoInput,
	HandstagesAgentPagesInput as PagesInput,
	HandstagesAgentReloadInput as ReloadInput,
	HandstagesAgentScrollInput as ScrollInput,
	HandstagesAgentSetActivePageInput as SetActivePageInput,
	HandstagesAgentSnapshotInput as SnapshotInput,
	HandstagesAgentTypeInput as TypeInput,
	HandstagesAgentTypeOnInput as TypeOnInput,
} from "./handlerTypes"
export * from "./handlerTypes"
export * from "./schemas"
