import {
  CORRESPONDENCE_GROUP_MIN_AREA_PX,
  CORRESPONDENCE_MAX_CONTEXT_GROUPS,
  CORRESPONDENCE_MEANINGFUL_ANCESTOR_MAX_AREA_PX,
  CORRESPONDENCE_MAX_SEARCH_GROUPS,
  CORRESPONDENCE_SMALL_GRAPHICS_MAX_AREA_PX,
  CORRESPONDENCE_TEXT_GROUP_FONT_DELTA_PX,
  CORRESPONDENCE_TEXT_GROUP_HEIGHT_DELTA_PX,
  CORRESPONDENCE_TEXT_GROUP_HEIGHT_RATIO,
  CORRESPONDENCE_TEXT_GROUP_LINE_HEIGHT_DELTA_PX,
} from "../config/defaults.js";
import type { ComparisonRegion, DomSnapshot, DomSnapshotElement } from "../types/internal.js";
import type { BoundingBox } from "../types/report.js";
import type { GroupBuildResult, GroupNode } from "./types.js";

interface GroupingContext {
  allElements: DomSnapshotElement[];
  elementsBySelector: Map<string, DomSnapshotElement>;
  directTextChildrenBySelector: Map<string, number>;
  directTextChildElementsBySelector: Map<string, DomSnapshotElement[]>;
  subtreeTextBySelector: Map<string, number>;
  diffLinkedElementIds: Set<string>;
  rootId: string;
}

export function buildGroups(params: {
  domSnapshot: DomSnapshot;
  rawRegions: ComparisonRegion[];
}): GroupBuildResult {
  const context = createGroupingContext(params.domSnapshot, params.rawRegions);
  const elementToGroupId = new Map<string, string>();
  const groupMembers = new Map<string, DomSnapshotElement[]>();

  for (const element of params.domSnapshot.elements) {
    const representative = resolveRepresentative(element, context);

    if (!representative) {
      continue;
    }

    elementToGroupId.set(element.id, representative.id);
    const existing = groupMembers.get(representative.id);

    if (existing) {
      existing.push(element);
    } else {
      groupMembers.set(representative.id, [element]);
    }
  }

  const groupsById = new Map<string, GroupNode>();
  const mismatchWeights = buildMismatchWeights(context, params.rawRegions, elementToGroupId);

  for (const [groupId, members] of groupMembers.entries()) {
    const representative = members.find((member) => member.id === groupId) ?? members[0];

    if (!representative) {
      continue;
    }

    const bbox = representative.bbox;
    const traits = buildTraits(members);
    groupsById.set(groupId, {
      id: groupId,
      selector: representative.selector,
      representativeElementId: representative.id,
      representativeElement: representative,
      bbox,
      area: bbox.width * bbox.height,
      depth: representative.depth,
      memberElementIds: members.map((member) => member.id).sort(),
      parentGroupId: null,
      childGroupIds: [],
      mismatchWeight: mismatchWeights.get(groupId) ?? 0,
      traits,
    });
  }

  for (const group of groupsById.values()) {
    group.parentGroupId = findParentGroupId(group.representativeElement, context, elementToGroupId);
  }

  for (const group of groupsById.values()) {
    if (!group.parentGroupId) {
      continue;
    }

    const parent = groupsById.get(group.parentGroupId);

    if (!parent) {
      continue;
    }

    parent.childGroupIds.push(group.id);
  }

  for (const group of groupsById.values()) {
    group.childGroupIds.sort((left, right) => {
      const leftGroup = groupsById.get(left);
      const rightGroup = groupsById.get(right);

      if (!leftGroup || !rightGroup) {
        return left.localeCompare(right);
      }

      if (leftGroup.bbox.y !== rightGroup.bbox.y) {
        return leftGroup.bbox.y - rightGroup.bbox.y;
      }

      return leftGroup.bbox.x - rightGroup.bbox.x;
    });
  }

  const groups = [...groupsById.values()].sort((left, right) => {
    if (left.depth !== right.depth) {
      return left.depth - right.depth;
    }

    if (left.bbox.y !== right.bbox.y) {
      return left.bbox.y - right.bbox.y;
    }

    return left.bbox.x - right.bbox.x;
  });

  return {
    domSnapshot: params.domSnapshot,
    rawRegions: params.rawRegions,
    groups,
    groupsById,
    elementToGroupId,
    searchGroupIds: selectSearchGroupIds(groups, groupsById),
  };
}

function createGroupingContext(
  domSnapshot: DomSnapshot,
  rawRegions: ComparisonRegion[],
): GroupingContext {
  const allElements = [...domSnapshot.elements, domSnapshot.root];
  const elementsBySelector = new Map(allElements.map((element) => [element.selector, element]));
  const directTextChildrenBySelector = new Map<string, number>();
  const directTextChildElementsBySelector = new Map<string, DomSnapshotElement[]>();
  const subtreeTextBySelector = new Map<string, number>();

  for (const element of domSnapshot.elements) {
    if (!hasOwnText(element)) {
      continue;
    }

    const parentSelector = element.ancestry[0]?.selector;

    if (parentSelector) {
      directTextChildrenBySelector.set(
        parentSelector,
        (directTextChildrenBySelector.get(parentSelector) ?? 0) + 1,
      );
      const existingChildren = directTextChildElementsBySelector.get(parentSelector);

      if (existingChildren) {
        existingChildren.push(element);
      } else {
        directTextChildElementsBySelector.set(parentSelector, [element]);
      }
    }

    for (const ancestor of element.ancestry) {
      subtreeTextBySelector.set(
        ancestor.selector,
        (subtreeTextBySelector.get(ancestor.selector) ?? 0) + 1,
      );
    }
  }

  return {
    allElements,
    elementsBySelector,
    directTextChildrenBySelector,
    directTextChildElementsBySelector,
    subtreeTextBySelector,
    diffLinkedElementIds: collectDiffLinkedElementIds(allElements, rawRegions),
    rootId: domSnapshot.root.id,
  };
}

function collectDiffLinkedElementIds(
  elements: DomSnapshotElement[],
  rawRegions: ComparisonRegion[],
): Set<string> {
  const ids = new Set<string>();

  for (const region of rawRegions) {
    const centerX = region.x + region.width / 2;
    const centerY = region.y + region.height / 2;
    let bestElement: DomSnapshotElement | null = null;
    let bestScore = 0;

    for (const element of elements) {
      const score = containsPoint(element.bbox, centerX, centerY)
        ? overlapRatio(region, element.bbox) + 1
        : overlapRatio(region, element.bbox);

      if (score > bestScore) {
        bestScore = score;
        bestElement = element;
      }
    }

    if (bestElement) {
      ids.add(bestElement.id);
    }
  }

  return ids;
}

function resolveRepresentative(
  element: DomSnapshotElement,
  context: GroupingContext,
): DomSnapshotElement | null {
  const area = element.bbox.width * element.bbox.height;
  const diffLinked = context.diffLinkedElementIds.has(element.id);

  if (hasOwnText(element)) {
    const textContainer = nearestTextContainer(element, context);

    if (textContainer) {
      return textContainer;
    }

    if (area >= CORRESPONDENCE_GROUP_MIN_AREA_PX || diffLinked) {
      return element;
    }

    return element.interactivity.isInteractive ? element : nearestUsefulAncestor(element, context);
  }

  if (area <= CORRESPONDENCE_SMALL_GRAPHICS_MAX_AREA_PX) {
    const meaningfulAncestor = nearestMeaningfulAncestor(element, context);

    if (meaningfulAncestor) {
      return meaningfulAncestor;
    }
  }

  let representative: DomSnapshotElement | null = element;

  for (const ancestorLocator of element.ancestry) {
    const ancestor = context.elementsBySelector.get(ancestorLocator.selector);

    if (!ancestor || ancestor.id === context.rootId) {
      break;
    }

    if (hasTextBoundary(ancestor, context)) {
      break;
    }

    representative = ancestor;
  }

  if (!representative) {
    return null;
  }

  const repArea = representative.bbox.width * representative.bbox.height;

  if (
    repArea >= CORRESPONDENCE_GROUP_MIN_AREA_PX ||
    diffLinked ||
    representative.interactivity.isInteractive
  ) {
    return representative;
  }

  return null;
}

function nearestTextContainer(
  element: DomSnapshotElement,
  context: GroupingContext,
): DomSnapshotElement | null {
  const immediateParentSelector = element.ancestry[0]?.selector;

  if (!immediateParentSelector) {
    return null;
  }

  const immediateParent = context.elementsBySelector.get(immediateParentSelector);

  if (!immediateParent || immediateParent.id === context.rootId) {
    return null;
  }

  const siblingTextCount = context.directTextChildrenBySelector.get(immediateParent.selector) ?? 0;

  if (
    siblingTextCount >= 2 &&
    shouldGroupIntoSharedTextContainer(element, immediateParent, context)
  ) {
    return immediateParent;
  }

  return null;
}

function shouldGroupIntoSharedTextContainer(
  element: DomSnapshotElement,
  parent: DomSnapshotElement,
  context: GroupingContext,
): boolean {
  const directTextChildren = context.directTextChildElementsBySelector.get(parent.selector) ?? [];
  const siblings = directTextChildren.filter((child) => child.id !== element.id);

  if (siblings.length === 0) {
    return false;
  }

  return !siblings.some((sibling) => hasStrongTextContrast(element, sibling));
}

function hasStrongTextContrast(left: DomSnapshotElement, right: DomSnapshotElement): boolean {
  const leftFontSize = parsePixelValue(left.computedStyle.fontSize);
  const rightFontSize = parsePixelValue(right.computedStyle.fontSize);
  const leftLineHeight = parsePixelValue(left.computedStyle.lineHeight);
  const rightLineHeight = parsePixelValue(right.computedStyle.lineHeight);
  const fontDelta = Math.abs(leftFontSize - rightFontSize);
  const lineHeightDelta = Math.abs(leftLineHeight - rightLineHeight);
  const heightDelta = Math.abs(left.bbox.height - right.bbox.height);
  const heightRatio =
    Math.max(left.bbox.height, right.bbox.height) /
    Math.max(1, Math.min(left.bbox.height, right.bbox.height));

  return (
    fontDelta >= CORRESPONDENCE_TEXT_GROUP_FONT_DELTA_PX ||
    lineHeightDelta >= CORRESPONDENCE_TEXT_GROUP_LINE_HEIGHT_DELTA_PX ||
    (heightDelta >= CORRESPONDENCE_TEXT_GROUP_HEIGHT_DELTA_PX &&
      heightRatio >= CORRESPONDENCE_TEXT_GROUP_HEIGHT_RATIO)
  );
}

function parsePixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nearestMeaningfulAncestor(
  element: DomSnapshotElement,
  context: GroupingContext,
): DomSnapshotElement | null {
  for (const ancestorLocator of element.ancestry) {
    const ancestor = context.elementsBySelector.get(ancestorLocator.selector);

    if (!ancestor || ancestor.id === context.rootId) {
      break;
    }

    const hasTextContext =
      hasOwnText(ancestor) ||
      (context.directTextChildrenBySelector.get(ancestor.selector) ?? 0) > 0 ||
      (context.subtreeTextBySelector.get(ancestor.selector) ?? 0) > 0;

    if (ancestor.interactivity.isInteractive || hasTextContext) {
      const ancestorArea = ancestor.bbox.width * ancestor.bbox.height;

      if (ancestorArea <= CORRESPONDENCE_MEANINGFUL_ANCESTOR_MAX_AREA_PX) {
        return ancestor;
      }
    }
  }

  return null;
}

function nearestUsefulAncestor(
  element: DomSnapshotElement,
  context: GroupingContext,
): DomSnapshotElement {
  for (const ancestorLocator of element.ancestry) {
    const ancestor = context.elementsBySelector.get(ancestorLocator.selector);

    if (!ancestor || ancestor.id === context.rootId) {
      break;
    }

    if (ancestor.interactivity.isInteractive || hasPaintedBox(ancestor)) {
      return ancestor;
    }
  }

  return element;
}

function hasTextBoundary(element: DomSnapshotElement, context: GroupingContext): boolean {
  return (
    hasOwnText(element) || (context.directTextChildrenBySelector.get(element.selector) ?? 0) > 0
  );
}

function hasOwnText(element: DomSnapshotElement): boolean {
  return Boolean(element.textSnippet?.trim());
}

function hasPaintedBox(element: DomSnapshotElement): boolean {
  const background = element.computedStyle.backgroundColor.trim().toLowerCase();
  return (
    background !== "" &&
    background !== "transparent" &&
    background !== "rgba(0, 0, 0, 0)" &&
    background !== "rgba(0,0,0,0)"
  );
}

function buildTraits(members: DomSnapshotElement[]): GroupNode["traits"] {
  const ownTextPresent = members.some((member) => hasOwnText(member));
  const isInteractive = members.some((member) => member.interactivity.isInteractive);
  const hasPainted = members.some((member) => hasPaintedBox(member));
  const isGraphicsOnly = members.every((member) => !hasOwnText(member));

  return {
    hasOwnText: ownTextPresent,
    hasTextDescendant: ownTextPresent,
    isInteractive,
    hasPaintedBox: hasPainted,
    isGraphicsOnly,
    isComposite: members.length > 1,
  };
}

function buildMismatchWeights(
  context: GroupingContext,
  rawRegions: ComparisonRegion[],
  elementToGroupId: Map<string, string>,
): Map<string, number> {
  const weights = new Map<string, number>();

  for (const region of rawRegions) {
    const centerX = region.x + region.width / 2;
    const centerY = region.y + region.height / 2;
    let bestElement: DomSnapshotElement | null = null;
    let bestScore = 0;

    for (const element of context.allElements) {
      const score = containsPoint(element.bbox, centerX, centerY)
        ? overlapRatio(region, element.bbox) + 1
        : overlapRatio(region, element.bbox);

      if (score > bestScore) {
        bestScore = score;
        bestElement = element;
      }
    }

    if (!bestElement) {
      continue;
    }

    const groupId = elementToGroupId.get(bestElement.id) ?? bestElement.id;
    weights.set(groupId, (weights.get(groupId) ?? 0) + region.pixelCount);
  }

  return weights;
}

function findParentGroupId(
  representative: DomSnapshotElement,
  context: GroupingContext,
  elementToGroupId: Map<string, string>,
): string | null {
  for (const ancestorLocator of representative.ancestry) {
    const ancestor = context.elementsBySelector.get(ancestorLocator.selector);

    if (!ancestor) {
      continue;
    }

    const groupId = elementToGroupId.get(ancestor.id);

    if (groupId && groupId !== representative.id) {
      return groupId;
    }
  }

  return null;
}

function selectSearchGroupIds(groups: GroupNode[], groupsById: Map<string, GroupNode>): string[] {
  const diffGroups = groups
    .filter((group) => group.mismatchWeight > 0)
    .sort((left, right) => right.mismatchWeight - left.mismatchWeight)
    .slice(0, CORRESPONDENCE_MAX_SEARCH_GROUPS)
    .map((group) => group.id);
  const selected = new Set(diffGroups);

  if (diffGroups.length === 0) {
    return [];
  }

  for (const groupId of diffGroups) {
    if (selected.size >= CORRESPONDENCE_MAX_SEARCH_GROUPS) {
      break;
    }

    const group = groupsById.get(groupId);
    if (!group?.parentGroupId || selected.has(group.parentGroupId)) {
      continue;
    }

    selected.add(group.parentGroupId);
  }

  for (const groupId of diffGroups) {
    if (selected.size >= CORRESPONDENCE_MAX_SEARCH_GROUPS) {
      break;
    }

    const group = groupsById.get(groupId);

    if (!group) {
      continue;
    }

    for (const childId of group.childGroupIds) {
      if (selected.size >= CORRESPONDENCE_MAX_SEARCH_GROUPS) {
        break;
      }

      if (selected.has(childId)) {
        continue;
      }

      const child = groupsById.get(childId);

      if (!child || (!child.traits.hasOwnText && !child.traits.isInteractive)) {
        continue;
      }

      selected.add(childId);
    }
  }

  for (const groupId of diffGroups) {
    if (selected.size >= CORRESPONDENCE_MAX_SEARCH_GROUPS) {
      break;
    }

    const group = groupsById.get(groupId);

    if (!group) {
      continue;
    }

    for (const descendantId of collectPrioritizedDescendants(group, groupsById, 2)) {
      if (selected.size >= CORRESPONDENCE_MAX_SEARCH_GROUPS) {
        break;
      }

      if (selected.has(descendantId)) {
        continue;
      }

      selected.add(descendantId);
    }
  }

  const contextCandidates = new Map<string, number>();

  for (const groupId of diffGroups) {
    const group = groupsById.get(groupId);

    if (!group || !group.parentGroupId) {
      continue;
    }

    const parent = groupsById.get(group.parentGroupId);

    if (!parent) {
      continue;
    }

    for (const siblingId of parent.childGroupIds) {
      if (selected.has(siblingId) || siblingId === groupId) {
        continue;
      }

      const sibling = groupsById.get(siblingId);
      if (!sibling) {
        continue;
      }

      const distance = centerDistance(group.bbox, sibling.bbox);
      const score = 1 / Math.max(1, distance);
      contextCandidates.set(siblingId, Math.max(contextCandidates.get(siblingId) ?? 0, score));
    }
  }

  const contextIds = [...contextCandidates.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(
      0,
      Math.min(CORRESPONDENCE_MAX_CONTEXT_GROUPS, CORRESPONDENCE_MAX_SEARCH_GROUPS - selected.size),
    )
    .map(([groupId]) => groupId);

  return [...selected, ...contextIds].slice(0, CORRESPONDENCE_MAX_SEARCH_GROUPS);
}

function collectPrioritizedDescendants(
  group: GroupNode,
  groupsById: Map<string, GroupNode>,
  maxDepth: number,
): string[] {
  const candidates: Array<{ id: string; priority: number }> = [];
  const queue = group.childGroupIds.map((childId) => ({ id: childId, depth: 1 }));

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || current.depth > maxDepth) {
      continue;
    }

    const currentGroup = groupsById.get(current.id);

    if (!currentGroup) {
      continue;
    }

    const priority =
      (currentGroup.traits.hasOwnText ? 3 : 0) +
      (currentGroup.traits.isInteractive ? 2 : 0) +
      (currentGroup.traits.isGraphicsOnly ? 1 : 0);

    if (priority > 0) {
      candidates.push({ id: current.id, priority });
    }

    for (const childId of currentGroup.childGroupIds) {
      queue.push({ id: childId, depth: current.depth + 1 });
    }
  }

  return candidates
    .sort((left, right) => right.priority - left.priority)
    .map((candidate) => candidate.id);
}

function overlapRatio(left: BoundingBox, right: BoundingBox): number {
  const intersectionWidth =
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const intersectionHeight =
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);

  if (intersectionWidth <= 0 || intersectionHeight <= 0) {
    return 0;
  }

  const intersectionArea = intersectionWidth * intersectionHeight;
  return (
    intersectionArea / Math.max(1, Math.min(left.width * left.height, right.width * right.height))
  );
}

function containsPoint(bbox: BoundingBox, x: number, y: number): boolean {
  return x >= bbox.x && x <= bbox.x + bbox.width && y >= bbox.y && y <= bbox.y + bbox.height;
}

function centerDistance(left: BoundingBox, right: BoundingBox): number {
  const leftCenterX = left.x + left.width / 2;
  const leftCenterY = left.y + left.height / 2;
  const rightCenterX = right.x + right.width / 2;
  const rightCenterY = right.y + right.height / 2;

  return Math.sqrt((leftCenterX - rightCenterX) ** 2 + (leftCenterY - rightCenterY) ** 2);
}
