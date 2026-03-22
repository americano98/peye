import {
  FINDING_DIRECTIONAL_GEOMETRY_CONFIDENCE,
  FINDING_DIRECTIONAL_GEOMETRY_MAX_AMBIGUITY,
} from "../config/defaults.js";
import type { CompareReport, FindingReport } from "../types/report.js";

const STYLE_PROPERTY_ORDER = [
  "fontSize",
  "lineHeight",
  "fontWeight",
  "color",
  "backgroundColor",
  "borderRadius",
  "gap",
  "padding",
  "margin",
  "width",
  "height",
] as const;

export function buildMarkdownTextReport(report: CompareReport): string {
  const lines: string[] = [
    "# Validation Summary",
    "",
    `- Recommendation: \`${report.summary.recommendation}\``,
    `- Severity: \`${report.summary.severity}\``,
    `- Reason: ${report.summary.reason}`,
    `- Top action: ${report.summary.topActions[0]?.code ?? "none"}`,
    `- Findings: ${report.findings.length}/${report.metrics.findingsCount}`,
    `- Mismatch percent: ${report.metrics.mismatchPercent.toFixed(4)}%`,
    `- Correspondence coverage: ${formatNullableMetric(report.summary.correspondenceCoverage)}`,
    `- Correspondence confidence: ${formatNullableMetric(report.summary.correspondenceConfidence)}`,
    "",
  ];

  if (report.findings.length === 0) {
    lines.push("## Findings", "", "No actionable findings were emitted.", "");
    return lines.join("\n");
  }

  lines.push("## Findings", "");

  report.findings.forEach((finding, index) => {
    lines.push(...renderFindingSection(index + 1, finding));
  });

  return lines.join("\n");
}

function renderFindingSection(index: number, finding: FindingReport): string[] {
  const target = finding.element?.selector ?? `visual-cluster-${index}`;
  const lines = [`### ${index}. \`${target}\``, ""];

  lines.push(`- Diagnosis: ${finding.summary}`);
  lines.push(`- Severity: \`${finding.severity}\``);
  lines.push(`- Code: \`${finding.code}\``);
  lines.push(`- Suggested fix: ${finding.fixHint}`);

  const evidenceLines = buildEvidenceLines(finding);

  if (evidenceLines.length > 0) {
    lines.push("- Evidence:");
    for (const evidenceLine of evidenceLines) {
      lines.push(`  - ${evidenceLine}`);
    }
  }

  const previewProps = buildRelevantPreviewProps(finding);

  if (previewProps) {
    lines.push(`- Current preview props: \`${JSON.stringify(previewProps)}\``);
  }

  const textLayout = finding.context?.semantic?.textLayout;

  if (textLayout) {
    lines.push(`- Current text layout: \`${JSON.stringify(textLayout)}\``);
  }

  lines.push("");
  return lines;
}

function buildEvidenceLines(finding: FindingReport): string[] {
  const lines: string[] = [];

  const geometryLine = buildGeometryEvidenceLine(finding);

  if (geometryLine) {
    lines.push(geometryLine);
  }

  const siblingRelationLine = buildSiblingRelationEvidenceLine(finding);

  if (siblingRelationLine) {
    lines.push(siblingRelationLine);
  }

  const textValidationLines = buildTextValidationEvidenceLines(finding);

  lines.push(...textValidationLines);

  if (finding.signals.length > 0) {
    lines.push(`signals: ${finding.signals.map((signal) => signal.code).join(", ")}`);
  }

  if (finding.correspondenceMethod) {
    lines.push(
      `correspondence: method=${finding.correspondenceMethod}, confidence=${finding.correspondenceConfidence?.toFixed(2) ?? "0.00"}, ambiguity=${finding.ambiguity?.toFixed(2) ?? "1.00"}`,
    );
  }

  return lines;
}

function buildGeometryEvidenceLine(finding: FindingReport): string | null {
  if (!finding.geometry || !finding.delta) {
    return null;
  }

  const { geometry, delta } = finding;
  const strongDirectionalEvidence =
    finding.correspondenceConfidence !== undefined &&
    finding.correspondenceConfidence >= FINDING_DIRECTIONAL_GEOMETRY_CONFIDENCE &&
    (finding.ambiguity ?? 1) <= FINDING_DIRECTIONAL_GEOMETRY_MAX_AMBIGUITY;

  if (
    strongDirectionalEvidence &&
    geometry.positionShiftLevel !== "none" &&
    geometry.sizeShiftLevel === "none"
  ) {
    if (Math.abs(delta.dy) > Math.abs(delta.dx) * 1.5) {
      return `geometry: vertically offset by about ${Math.abs(delta.dy)}px relative to the reference`;
    }

    if (Math.abs(delta.dx) > Math.abs(delta.dy) * 1.5) {
      return `geometry: horizontally offset by about ${Math.abs(delta.dx)}px relative to the reference`;
    }
  }

  if (
    strongDirectionalEvidence &&
    geometry.sizeShiftLevel !== "none" &&
    geometry.positionShiftLevel === "none"
  ) {
    if (Math.abs(delta.dw) > Math.abs(delta.dh) * 1.5) {
      return `geometry: width differs by ${formatSigned(delta.dw)}px relative to the reference`;
    }

    if (Math.abs(delta.dh) > Math.abs(delta.dw) * 1.5) {
      return `geometry: height differs by ${formatSigned(delta.dh)}px relative to the reference`;
    }
  }

  if (geometry.positionShiftLevel !== "none" || geometry.sizeShiftLevel !== "none") {
    if (!strongDirectionalEvidence) {
      return "geometry: the matched element differs from the reference area, but directional deltas are too uncertain for a precise claim";
    }

    return `geometry: shifted by about ${Math.round(geometry.centerShiftPx)}px, widthDelta=${formatSigned(geometry.widthDeltaPx)}px, heightDelta=${formatSigned(geometry.heightDeltaPx)}px`;
  }

  return null;
}

function buildSiblingRelationEvidenceLine(finding: FindingReport): string | null {
  if (!finding.siblingRelation) {
    return null;
  }

  return `sibling relation: ${finding.siblingRelation.axis} gap vs \`${finding.siblingRelation.siblingSelector}\` differs by ${formatSigned(finding.siblingRelation.gapDeltaPx)}px, cross-axis offset delta is ${finding.siblingRelation.crossAxisOffsetDeltaPx}px`;
}

function buildRelevantPreviewProps(finding: FindingReport): Record<string, string> | null {
  const computedStyle = finding.context?.semantic?.computedStyle;

  if (!computedStyle) {
    return null;
  }

  const keys = new Set<(typeof STYLE_PROPERTY_ORDER)[number]>();

  for (const property of finding.likelyAffectedProperties) {
    switch (property) {
      case "layout.position":
      case "layout.alignment":
      case "layout.spacing":
        keys.add("gap");
        keys.add("padding");
        keys.add("margin");
        keys.add("width");
        keys.add("height");
        break;
      case "size.width":
        keys.add("width");
        break;
      case "size.height":
        keys.add("height");
        break;
      case "style.color":
        keys.add("color");
        break;
      case "style.background":
        keys.add("backgroundColor");
        break;
      case "style.border":
      case "style.radius":
        keys.add("borderRadius");
        break;
      case "style.typography":
        keys.add("fontSize");
        keys.add("lineHeight");
        keys.add("fontWeight");
        keys.add("color");
        break;
      case "text.overflow":
      case "text.lineClamp":
        keys.add("width");
        keys.add("height");
        keys.add("fontSize");
        keys.add("lineHeight");
        keys.add("fontWeight");
        keys.add("margin");
        break;
      case "style.shadow":
      case "capture.selectorScope":
      case "capture.viewport":
      case "reference.frame":
        break;
      default:
        break;
    }
  }

  if (finding.textValidation) {
    keys.add("fontSize");
    keys.add("lineHeight");
    keys.add("fontWeight");
    keys.add("width");
    keys.add("height");
    keys.add("margin");
  }

  const result: Record<string, string> = {};

  for (const key of STYLE_PROPERTY_ORDER) {
    if (keys.has(key)) {
      result[key] = computedStyle[key];
    }
  }

  return Object.keys(result).length === 0 ? null : result;
}

function formatNullableMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function buildTextValidationEvidenceLines(finding: FindingReport): string[] {
  if (!finding.textValidation) {
    return [];
  }

  const lines = [
    `text validation: status=${finding.textValidation.status}, diagnosis=${finding.textValidation.diagnosisKind}, confidence=${finding.textValidation.confidence.toFixed(2)}`,
  ];

  for (const observation of finding.textValidation.observations) {
    lines.push(`text observation: ${observation}`);
  }

  return lines;
}
