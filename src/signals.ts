import type { SearchIssue, ChangelogItem } from "./jira/search";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely extracts the "toString" property from a ChangelogItem.
 *
 * The Jira REST API returns a property literally named "toString" in changelog
 * items. In JavaScript, every object has a built-in toString() method inherited
 * from Object.prototype. While JSON.parse does create an own property that
 * shadows the prototype method, accessing it via dot notation (item.toString)
 * can behave unexpectedly in some runtimes or after bundling.
 *
 * Using bracket notation ensures we always get the actual JSON property value.
 */
function getToString(item: ChangelogItem): string | null {
  return (item as unknown as Record<string, string | null>)["toString"] ?? null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single recorded assignee change. */
export interface AssigneeChange {
  from: string | null;
  to: string | null;
  date: string;
}

/** Parsed assignee-change signal for an issue. */
export interface AssigneeSignal {
  count: number;
  changes: AssigneeChange[];
}

/** A single recorded estimate change. */
export interface EstimateChange {
  field: string;
  from: string | null;
  to: string | null;
  date: string;
}

/**
 * The most recent value-to-value estimate change.
 * Null when there are no changes, or when the change is from/to unestimated.
 */
export interface EstimateDrift {
  from: string;
  to: string;
  display: string;
  changePercent: number | null;
}

/** A bucket of estimate changes with optional drift. */
export interface EstimateBucket {
  count: number;
  changes: EstimateChange[];
  latestDrift: EstimateDrift | null;
}

/** Estimate changes grouped into points and time buckets. */
export interface EstimateSignal {
  points: EstimateBucket;
  time: EstimateBucket;
  totalChanges: number;
}

/** Sprint age signal — how long since the issue was first placed in a sprint. */
export interface SprintAgeSignal {
  firstSprintDate: string | null;
  ageDays: number | null;
}

/**
 * The assessment result for a single issue.
 * Contains the issue metadata plus all parsed changelog signals and risk rating.
 */
export interface IssueAssessment {
  key: string;
  summary: string;
  type: string;
  status: string;
  statusCategory: string;
  assignee: string;
  priority: string;
  hasEstimate: boolean;
  sprintCount: number;
  sprintNames: string[];
  risk: "High" | "Medium" | "Low";
  assigneeChanges: AssigneeSignal;
  estimateChanges: EstimateSignal;
  sprintAge: SprintAgeSignal;
}

// ---------------------------------------------------------------------------
// Carry-Over Parsing
// ---------------------------------------------------------------------------

/**
 * Parses the changelog of an issue to determine how many distinct sprints
 * it has been assigned to.
 *
 * How it works:
 * The Jira changelog records sprint changes with field="Sprint". The `toString`
 * value is a cumulative comma-separated list of ALL sprints the issue has ever
 * been in — not just the current one. Completed sprints persist in the list.
 *
 * Example changelog entry:
 *   field: "Sprint"
 *   fromString: "Sprint 1, Sprint 2"
 *   toString: "Sprint 1, Sprint 2, Sprint 3"
 *
 * We take the MOST RECENT Sprint changelog entry's `toString` value, split
 * by comma, and count the distinct sprint names. This gives us the total
 * number of sprints the issue has been in.
 *
 * Returns the count of distinct sprints, or 0 if no Sprint changelog found.
 */
export function parseCarryOverCount(issue: SearchIssue): {
  count: number;
  sprintNames: string[];
} {
  if (!issue.changelog?.histories || issue.changelog.histories.length === 0) {
    return { count: 1, sprintNames: [] };
  }

  const histories = issue.changelog.histories;

  // Collect all Sprint changelog items with their "toString" values
  // We use a helper to safely extract the toString property from each item
  const sprintChanges: { index: number; toValue: string | null }[] = [];
  for (let i = 0; i < histories.length; i++) {
    const entry = histories[i]!;
    for (const item of entry.items) {
      if (item.field === "Sprint") {
        const toValue = getToString(item);
        sprintChanges.push({ index: i, toValue });
      }
    }
  }

  if (sprintChanges.length === 0) {
    return { count: 1, sprintNames: [] };
  }

  // Find the most recent Sprint change with a valid toString value.
  // The most recent entry may have null/empty toString if the issue was
  // removed from a sprint — in that case fall back to the next entry.
  for (const change of sprintChanges) {
    const toValue = change.toValue;

    // Skip null, empty, or literal "null" string (Jira serialisation quirk)
    if (!toValue || toValue === "null" || toValue.trim() === "") {
      continue;
    }

    const sprints = toValue
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const unique = [...new Set(sprints)];
    return { count: unique.length, sprintNames: unique };
  }

  // All Sprint changelog entries had null/empty toString — default to 1
  return { count: 1, sprintNames: [] };
}

// ---------------------------------------------------------------------------
// Assignee Change Parsing
// ---------------------------------------------------------------------------

/**
 * Parses the changelog to count how many times the issue was reassigned.
 * Looks for changelog items where field === "assignee".
 */
export function parseAssigneeChanges(issue: SearchIssue): AssigneeSignal {
  const changes: AssigneeChange[] = [];

  if (!issue.changelog?.histories) {
    return { count: 0, changes };
  }

  for (const entry of issue.changelog.histories) {
    for (const item of entry.items) {
      if (item.field === "assignee") {
        changes.push({
          from: item.fromString ?? null,
          to: getToString(item),
          date: entry.created,
        });
      }
    }
  }

  return { count: changes.length, changes };
}

// ---------------------------------------------------------------------------
// Estimate Change Parsing
// ---------------------------------------------------------------------------

/**
 * Field name patterns used to classify estimate changes into buckets.
 *
 * Points: "Story Points", "story_points", or any field containing "point"
 * Time: "timeestimate", "timeoriginalestimate", "Original Estimate",
 *       "Remaining Estimate", or any field containing "time" + estimate-like patterns
 */
const POINTS_PATTERNS = [
  /^story\s*points$/i,
  /point/i,
];

const TIME_PATTERNS = [
  /^timeestimate$/i,
  /^timeoriginalestimate$/i,
  /^original\s*estimate$/i,
  /^remaining\s*estimate$/i,
  /time.*estimate/i,
  /estimate.*time/i,
];

function isPointsField(fieldName: string): boolean {
  return POINTS_PATTERNS.some((p) => p.test(fieldName));
}

function isTimeField(fieldName: string): boolean {
  return TIME_PATTERNS.some((p) => p.test(fieldName));
}

/**
 * Formats a time value in seconds to a human-readable string.
 * Uses the largest fitting unit: days (d), hours (h), or minutes (m).
 * Drops trailing .0 for clean display.
 */
export function formatTimeEstimate(seconds: number): string {
  if (seconds >= 86400) {
    const days = seconds / 86400;
    return `${stripTrailingZero(days)}d`;
  }
  if (seconds >= 3600) {
    const hours = seconds / 3600;
    return `${stripTrailingZero(hours)}h`;
  }
  if (seconds >= 60) {
    const minutes = seconds / 60;
    return `${stripTrailingZero(minutes)}m`;
  }
  return `${seconds}s`;
}

function stripTrailingZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1);
}

/**
 * Checks whether a raw estimate value represents an empty/unestimated state.
 */
function isEmptyEstimate(value: string | null): boolean {
  return !value || value.trim() === "" || value === "null";
}

/**
 * Formats a raw estimate value for display.
 * Points: returned as-is.
 * Time: parsed as seconds and formatted to h/d/m.
 */
function formatEstimateValue(
  value: string,
  bucket: "points" | "time",
): string {
  if (bucket === "points") {
    return value;
  }
  // If the value already contains a time unit suffix (d/h/m/s),
  // it's a display string — return as-is.
  if (/[dhms]\s*$/i.test(value)) {
    return value;
  }
  // Time bucket: value is typically in seconds as a pure number
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return formatTimeEstimate(parsed);
}

/**
 * Parses a raw estimate value to a numeric value for percentage calculation.
 * Points: parseFloat directly.
 * Time: parseFloat (already in seconds from Jira).
 * Returns null if unparseable.
 */
function parseEstimateNumeric(value: string): number | null {
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Computes percentage change between two numeric values.
 * Returns null if either value is unparseable or the base value is 0.
 * Positive = increase, negative = decrease.
 */
function computeChangePercent(
  fromRaw: string,
  toRaw: string,
): number | null {
  const fromNum = parseEstimateNumeric(fromRaw);
  const toNum = parseEstimateNumeric(toRaw);
  if (fromNum === null || toNum === null || fromNum === 0) return null;
  return Math.round(((toNum - fromNum) / fromNum) * 100);
}

/**
 * Computes the latest drift for a bucket of estimate changes.
 * Returns null if:
 * - No changes exist
 * - The most recent change is from unestimated to estimated (first estimate)
 * - The most recent change is from estimated to unestimated (estimate removed)
 */
function computeLatestDrift(
  changes: EstimateChange[],
  bucket: "points" | "time",
): EstimateDrift | null {
  if (changes.length === 0) return null;

  // Most recent change is first in the array (changelog is newest-first)
  const latest = changes[0]!;

  const fromEmpty = isEmptyEstimate(latest.from);
  const toEmpty = isEmptyEstimate(latest.to);

  // First estimate or estimate removed — not drift
  if (fromEmpty || toEmpty) return null;

  const fromDisplay = formatEstimateValue(latest.from!, bucket);
  const toDisplay = formatEstimateValue(latest.to!, bucket);
  const changePercent = computeChangePercent(latest.from!, latest.to!);

  return {
    from: fromDisplay,
    to: toDisplay,
    display: `${fromDisplay} -> ${toDisplay}`,
    changePercent,
  };
}

/**
 * Infers whether an issue has been estimated by scanning its changelog.
 *
 * Returns true if any estimate-related changelog entry has a non-empty
 * "to" value — meaning an estimate was set at some point.
 *
 * Known blind spot: issues estimated at creation time with no subsequent
 * changes will not have a changelog entry, so this returns false.
 */
export function inferHasEstimate(issue: SearchIssue): boolean {
  if (!issue.changelog?.histories) return false;

  for (const entry of issue.changelog.histories) {
    for (const item of entry.items) {
      const fieldName = item.field;
      if (isPointsField(fieldName) || isTimeField(fieldName)) {
        const toValue = getToString(item) ?? item.to;
        if (toValue && toValue.trim() !== "" && toValue !== "null") {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Parses the changelog to count estimate changes, grouped into
 * points-based and time-based buckets, with optional drift display.
 */
export function parseEstimateChanges(issue: SearchIssue): EstimateSignal {
  const points: EstimateChange[] = [];
  const time: EstimateChange[] = [];

  if (!issue.changelog?.histories) {
    return {
      points: { count: 0, changes: [], latestDrift: null },
      time: { count: 0, changes: [], latestDrift: null },
      totalChanges: 0,
    };
  }

  for (const entry of issue.changelog.histories) {
    for (const item of entry.items) {
      const fieldName = item.field;
      const change: EstimateChange = {
        field: fieldName,
        from: item.fromString ?? item.from,
        to: getToString(item) ?? item.to,
        date: entry.created,
      };

      if (isPointsField(fieldName)) {
        points.push(change);
      } else if (isTimeField(fieldName)) {
        time.push(change);
      }
    }
  }

  return {
    points: {
      count: points.length,
      changes: points,
      latestDrift: computeLatestDrift(points, "points"),
    },
    time: {
      count: time.length,
      changes: time,
      latestDrift: computeLatestDrift(time, "time"),
    },
    totalChanges: points.length + time.length,
  };
}

// ---------------------------------------------------------------------------
// Sprint Age Parsing
// ---------------------------------------------------------------------------

/**
 * Determines how long ago the issue was first assigned to a sprint.
 *
 * Looks for the earliest changelog entry where field === "Sprint" and
 * fromString is null or empty — indicating the issue was placed into a
 * sprint for the first time (as opposed to being moved between sprints).
 *
 * Returns the date of that first assignment and the age in days.
 * If no qualifying entry is found, returns null for both fields.
 */
export function parseSprintAge(
  issue: SearchIssue,
  now: Date = new Date(),
): SprintAgeSignal {
  if (!issue.changelog?.histories || issue.changelog.histories.length === 0) {
    return { firstSprintDate: null, ageDays: null };
  }

  let earliestDate: string | null = null;

  // Histories are ordered newest-first in the Jira API response,
  // so we iterate in reverse to find the earliest qualifying entry.
  const histories = issue.changelog.histories;
  for (let i = histories.length - 1; i >= 0; i--) {
    const entry = histories[i]!;
    for (const item of entry.items) {
      if (item.field === "Sprint") {
        const from = item.fromString;
        // First sprint assignment: fromString is null, empty, or whitespace
        if (!from || from.trim() === "") {
          earliestDate = entry.created;
          break;
        }
      }
    }
    if (earliestDate) break;
  }

  if (!earliestDate) {
    return { firstSprintDate: null, ageDays: null };
  }

  const firstDate = new Date(earliestDate);
  const diffMs = now.getTime() - firstDate.getTime();
  const ageDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  return { firstSprintDate: earliestDate, ageDays };
}

// ---------------------------------------------------------------------------
// Risk Assessment
// ---------------------------------------------------------------------------

/**
 * Assesses carry-over risk based on sprint count.
 *
 * Thresholds:
 * - High: 3+ sprints (carried over at least twice)
 * - Medium: 2 sprints (carried over once)
 * - Low: 1 or fewer (no carry-over)
 */
export function assessCarryOverRisk(
  sprintCount: number,
): "High" | "Medium" | "Low" {
  if (sprintCount >= 3) return "High";
  if (sprintCount >= 2) return "Medium";
  return "Low";
}

// ---------------------------------------------------------------------------
// Issue Assessment
// ---------------------------------------------------------------------------

/**
 * Produces a complete assessment for a single issue by parsing its changelog
 * and applying all signal parsers plus the carry-over risk rubric.
 */
export function assessIssue(issue: SearchIssue): IssueAssessment {
  const { count, sprintNames } = parseCarryOverCount(issue);
  const risk = assessCarryOverRisk(count);
  const assigneeChanges = parseAssigneeChanges(issue);
  const estimateChanges = parseEstimateChanges(issue);
  const sprintAge = parseSprintAge(issue);

  return {
    key: issue.key,
    summary: issue.fields.summary,
    type: issue.fields.issuetype.name,
    status: issue.fields.status.name,
    statusCategory: issue.fields.status.statusCategory.name,
    assignee: issue.fields.assignee?.displayName ?? "Unassigned",
    priority: issue.fields.priority?.name ?? "-",
    hasEstimate: inferHasEstimate(issue),
    sprintCount: count,
    sprintNames,
    risk,
    assigneeChanges,
    estimateChanges,
    sprintAge,
  };
}
