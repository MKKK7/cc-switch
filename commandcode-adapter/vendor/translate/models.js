// Local override: the server validates against the live catalog. No aliases,
// premium-to-cheap remapping, default model substitution or effort coercion.
export function resolveModel(model) { return model; }
export function resolveEffortForModel(_model, effort) { return effort; }
