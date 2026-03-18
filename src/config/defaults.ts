import type { CompareMode, CompareThresholds } from "../types/report.js";

export const DEFAULT_MODE: CompareMode = "all";

export const DEFAULT_THRESHOLDS: CompareThresholds = {
  pass: 0.5,
  tolerated: 1.5,
  retry: 5,
};

export const DEFAULT_PIXELMATCH_THRESHOLD = 0.1;
export const DEFAULT_EDGE_THRESHOLD = 96;
export const DEFAULT_MIN_REGION_PIXELS = 9;
export const DEFAULT_CAPTURE_DELAY_MS = 250;
export const DEFAULT_VIEWPORT_HEIGHT = 900;
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
export const DEFAULT_RESOURCE_TIMEOUT_MS = 15_000;
export const DEFAULT_FONT_READY_TIMEOUT_MS = 5_000;
export const DEFAULT_REPORT_FINDINGS_LIMIT = 20;
export const DEFAULT_MAX_TEXT_SNIPPET_LENGTH = 80;
export const DEFAULT_MAX_SELECTOR_LENGTH = 120;
export const DEFAULT_MAX_TAG_ROLLUPS = 10;
export const DEFAULT_DOM_OVERLAP_THRESHOLD = 0.3;
export const DEFAULT_CLUSTER_PADDING_PX = 8;
export const DEFAULT_HOTSPOT_CLUSTER_PADDING_PX = 6;
export const DEFAULT_HOTSPOT_LIMIT_PER_FINDING = 5;
export const DEFAULT_FIGMA_SOURCE = "auto";
export const DEFAULT_FIGMA_API_BASE_URL = "https://api.figma.com";
export const DEFAULT_FIGMA_MCP_DESKTOP_URL = "http://127.0.0.1:3845/mcp";
export const DEFAULT_FIGMA_MCP_REMOTE_URL = "https://mcp.figma.com/mcp";
export const DEFAULT_FIGMA_OAUTH_TIMEOUT_MS = 180_000;
export const LAYOUT_EDGE_RATIO_THRESHOLD = 0.35;
export const COLOR_REGION_DELTA_THRESHOLD = 10;
export const STRONG_DIMENSION_DELTA_PX = 40;
export const STRONG_DIMENSION_ASPECT_DELTA = 0.1;
export const HUMAN_REVIEW_MISMATCH_MULTIPLIER = 3;
export const MAX_RGB_DISTANCE = 441.6729559300637;
