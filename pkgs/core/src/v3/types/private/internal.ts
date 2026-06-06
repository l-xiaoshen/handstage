export type EncodedId = `${number}-${number}`

export type InitScriptSource<Arg> =
	| string
	| { path?: string; content?: string }
	| ((arg: Arg) => unknown)
