export const CAPABILITY_PATCHES = [
    {
        match: (m) => m.id.includes("gpt-5.2") ||
            m.id.includes("gpt-5.3") ||
            m.id.includes("gpt-5.4"),
        caps: { supportsXhigh: true, supportsServiceTier: true },
    },
    {
        match: (m) => m.id.includes("gpt-5.5") || m.id.includes("gpt-5.6"),
        caps: { supportsXhigh: true },
    },
    {
        match: (m) => m.api === "anthropic-messages" &&
            (m.id.includes("opus-4-6") ||
                m.id.includes("opus-4.6") ||
                m.id.includes("opus-4-7") ||
                m.id.includes("opus-4.7") ||
                m.id.includes("opus-4-8") ||
                m.id.includes("opus-4.8") ||
                m.id.includes("opus-5") ||
                m.id.includes("opus.5") ||
                m.id.includes("fable-5") ||
                m.id.includes("fable.5")),
        caps: { supportsXhigh: true },
    },
];
/** Apply GSD capability patches after assembling a model list. */
export function applyCapabilityPatches(models) {
    return models.map((model) => {
        for (const patch of CAPABILITY_PATCHES) {
            if (patch.match(model)) {
                return {
                    ...model,
                    capabilities: {
                        ...patch.caps,
                        ...model.capabilities,
                    },
                };
            }
        }
        return model;
    });
}
