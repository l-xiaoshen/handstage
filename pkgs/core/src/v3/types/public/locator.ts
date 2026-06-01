export type MouseButton = "left" | "right" | "middle"

export interface SetInputFilePayload {
	name: string
	mimeType?: string
	buffer: Uint8Array
	lastModified?: number
}

export type SetInputFilesArgument = SetInputFilePayload | SetInputFilePayload[]
