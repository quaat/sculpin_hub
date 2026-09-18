export const FOUNDRY_MODELS = ["claude-opus-5", "claude-fable-5"] as const;
export type FoundryModel = (typeof FOUNDRY_MODELS)[number];
