import type { z } from "zod"
import type {
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
	HandstageAgentPageEntrySchema,
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
	// TypeOnInputSchema,
	// TypeOutputSchema,
} from "./schemas"

export type PagesInput = z.infer<typeof PagesInputSchema>
export type PagesOutput = z.infer<typeof PagesOutputSchema>
export type PageEntry = z.infer<typeof HandstageAgentPageEntrySchema>

export type NewPageInput = z.infer<typeof NewPageInputSchema>
export type NewPageOutput = z.infer<typeof NewPageOutputSchema>

// export type BringToFrontInput = z.infer<typeof BringToFrontInputSchema>
// export type BringToFrontOutput = z.infer<typeof BringToFrontOutputSchema>

export type ClosePageInput = z.infer<typeof ClosePageInputSchema>
export type ClosePageOutput = z.infer<typeof ClosePageOutputSchema>

export type GotoInput = z.infer<typeof GotoInputSchema>
export type GotoOutput = z.infer<typeof GotoOutputSchema>

export type ReloadInput = z.infer<typeof ReloadInputSchema>
export type ReloadOutput = z.infer<typeof ReloadOutputSchema>

export type GoBackInput = z.infer<typeof GoBackInputSchema>
export type GoBackOutput = z.infer<typeof HistoryNavOutputSchema>

export type GoForwardInput = z.infer<typeof GoForwardInputSchema>
export type GoForwardOutput = z.infer<typeof HistoryNavOutputSchema>

export type SnapshotDomInput = z.infer<typeof SnapshotDomInputSchema>
export type SnapshotDomOutput = z.infer<typeof SnapshotDomOutputSchema>

// export type PageInfoInput = z.infer<typeof PageInfoInputSchema>
// export type PageInfoOutput = z.infer<typeof PageInfoOutputSchema>

// export type ClickInput = z.infer<typeof ClickInputSchema>
// export type ClickOutput = z.infer<typeof PointerOutputSchema>

// export type HoverInput = z.infer<typeof HoverInputSchema>
// export type HoverOutput = z.infer<typeof PointerOutputSchema>

// export type ScrollInput = z.infer<typeof ScrollInputSchema>
// export type ScrollOutput = z.infer<typeof PointerOutputSchema>

// export type TypeInput = z.infer<typeof TypeInputSchema>
// export type TypeOutput = z.infer<typeof TypeOutputSchema>

// export type ClickOnInput = z.infer<typeof ClickOnInputSchema>
// export type ClickOnOutput = z.infer<typeof ElementActionOutputSchema>

// export type FillOnInput = z.infer<typeof FillOnInputSchema>
// export type FillOnOutput = z.infer<typeof ElementActionOutputSchema>

// export type TypeOnInput = z.infer<typeof TypeOnInputSchema>
// export type TypeOnOutput = z.infer<typeof ElementActionOutputSchema>

// export type HoverOnInput = z.infer<typeof HoverOnInputSchema>
// export type HoverOnOutput = z.infer<typeof ElementActionOutputSchema>

export type ClickOnIdInput = z.infer<typeof ClickOnIdInputSchema>
export type ClickOnIdOutput = z.infer<typeof ElementActionOutputSchema>

export type FillOnIdInput = z.infer<typeof FillOnIdInputSchema>
export type FillOnIdOutput = z.infer<typeof ElementActionOutputSchema>

export type TypeOnIdInput = z.infer<typeof TypeOnIdInputSchema>
export type TypeOnIdOutput = z.infer<typeof ElementActionOutputSchema>

export type HoverOnIdInput = z.infer<typeof HoverOnIdInputSchema>
export type HoverOnIdOutput = z.infer<typeof ElementActionOutputSchema>

export type OkResult = Extract<ClickOnIdOutput, { ok: true }>
export type ErrResult = Extract<ClickOnIdOutput, { ok: false }>
