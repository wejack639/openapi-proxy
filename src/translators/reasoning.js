export function mapReasoning(request = {}, provider = {}) {
  const providerReasoning = provider.reasoning || {};
  if (providerReasoning.enabled === false) {
    return {
      thinking: { type: "disabled" },
      effective_effort: "none",
      enabled: false
    };
  }

  const rawEffort = request.reasoning?.effort || request.reasoning_effort || providerReasoning.effort || "high";
  const effort = String(rawEffort).toLowerCase();
  const minimalPolicy = providerReasoning.minimal_policy || "disabled";

  if (effort === "none" || (effort === "minimal" && minimalPolicy === "disabled")) {
    return {
      thinking: { type: "disabled" },
      effective_effort: effort,
      enabled: false
    };
  }

  const deepseekEffort = effort === "xhigh" || effort === "max" ? "max" : "high";
  return {
    thinking: { type: "enabled" },
    reasoning_effort: deepseekEffort,
    effective_effort: deepseekEffort,
    enabled: true
  };
}
