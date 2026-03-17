import type { Severity } from "../types/report.js";

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function maxSeverity(values: Severity[]): Severity {
  if (values.length === 0) {
    return "low";
  }

  return values.reduce((current, candidate) =>
    SEVERITY_RANK[candidate] > SEVERITY_RANK[current] ? candidate : current,
  );
}

export function compareSeverityDescending(left: Severity, right: Severity): number {
  return SEVERITY_RANK[right] - SEVERITY_RANK[left];
}
