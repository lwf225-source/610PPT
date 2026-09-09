export function qaDecisionKey(issue = {}) {
  return String(issue.pageNo || "").trim() || "deck";
}

export function qaDecisionKeys(issues = []) {
  const decisionIssues = (issues || []).filter((issue) => issue?.requiresDecision !== false);
  const pageKeys = [...new Set(decisionIssues
    .map((issue) => String(issue?.pageNo || "").trim())
    .filter(Boolean))];
  if (pageKeys.length) return pageKeys;
  return decisionIssues.length ? ["deck"] : [];
}

export function unresolvedQaDecisionKeys(qa = {}) {
  const decisions = qa?.decisions && typeof qa.decisions === "object" ? qa.decisions : {};
  return qaDecisionKeys(qa?.issues || []).filter((key) => {
    const decision = decisions[key]?.decision;
    return !["fix", "ignore"].includes(decision);
  });
}

export function qaDecisionSummary(qa = {}) {
  const requiredKeys = qaDecisionKeys(qa?.issues || []);
  const unresolvedKeys = unresolvedQaDecisionKeys(qa);
  const hardBlockKeys = [...new Set((qa?.issues || [])
    .filter((issue) => issue?.requiresDecision !== false && issue?.hardBlock === true)
    .map(qaDecisionKey))];
  const decisions = qa?.decisions && typeof qa.decisions === "object" ? qa.decisions : {};
  const fixKeys = requiredKeys.filter((key) => decisions[key]?.decision === "fix");
  const ignoreKeys = requiredKeys.filter((key) => decisions[key]?.decision === "ignore");
  return {
    requiredKeys,
    unresolvedKeys,
    hardBlockKeys,
    fixKeys,
    ignoreKeys,
    resolvedCount: requiredKeys.length - unresolvedKeys.length,
    canStartFixes: unresolvedKeys.length === 0 && fixKeys.length > 0,
    canExport: unresolvedKeys.length === 0 && fixKeys.length === 0
  };
}
