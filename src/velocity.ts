import type {
  SprintReportResponse,
  SprintReportEstimateSum,
} from "./jira/software/board";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SprintVelocityData {
  sprintId: number;
  sprintName: string;
  completedIssues: number;
  totalIssues: number;
  completedPoints: number | null;
  totalPoints: number | null;
}

export type RangeVerdict =
  | "Below recent range"
  | "Within recent range"
  | "Above recent range";

export interface VelocitySignal {
  /** Up to 3 previous closed sprints, most recent first. */
  history: SprintVelocityData[];
  /** Current sprint commitment. */
  current: {
    totalIssues: number;
    totalPoints: number | null;
  };
  averageCompletedIssues: number;
  averageCompletedPoints: number | null;
  issuePercentDiff: number;
  pointsPercentDiff: number | null;
  issueRangeVerdict: RangeVerdict;
  pointsRangeVerdict: RangeVerdict | null;
  /**
   * True when points commitment is above the historical max but issue count
   * is within ±15% of the historical average — suggests larger estimates
   * without proportionally more work items.
   */
  overCommitmentFlag: boolean;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Extracts numeric value from a GreenHopper estimate sum.
 * Returns null when the team does not use story points (text === "null", no value key).
 */
function parseEstimateSum(sum: SprintReportEstimateSum): number | null {
  if ("value" in sum && typeof sum.value === "number") {
    return sum.value;
  }
  return null;
}

/**
 * Converts a raw GreenHopper sprint report into a SprintVelocityData record.
 */
export function parseSprintReport(
  report: SprintReportResponse,
): SprintVelocityData {
  const c = report.contents;

  const completedIssues = c.completedIssues.length;
  const totalIssues =
    c.completedIssues.length +
    c.issuesNotCompletedInCurrentSprint.length +
    c.puntedIssues.length;

  const completedPoints = parseEstimateSum(c.completedIssuesEstimateSum);
  const totalPoints = parseEstimateSum(c.allIssuesEstimateSum);

  return {
    sprintId: report.sprint.id,
    sprintName: report.sprint.name,
    completedIssues,
    totalIssues,
    completedPoints,
    totalPoints,
  };
}

// ---------------------------------------------------------------------------
// Compute velocity signal
// ---------------------------------------------------------------------------

function computeRangeVerdict(
  current: number,
  values: number[],
): RangeVerdict {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (current < min) return "Below recent range";
  if (current > max) return "Above recent range";
  return "Within recent range";
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percentDiff(current: number, avg: number): number {
  if (avg === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - avg) / avg) * 100 * 10) / 10;
}

/**
 * Default threshold for the over-commitment heuristic.
 * Over-commitment is flagged when points are above the historical max
 * but issue count is within ±OVER_COMMIT_ISSUE_THRESHOLD_PERCENT of
 * the historical average.
 */
const OVER_COMMIT_ISSUE_THRESHOLD_PERCENT = 15;

/**
 * Computes the velocity signal by comparing the current sprint's
 * committed load against completed metrics from previous sprints.
 *
 * Requires at least 1 historical sprint. Returns null if history is empty.
 */
export function computeVelocitySignal(
  history: SprintVelocityData[],
  current: { totalIssues: number; totalPoints: number | null },
): VelocitySignal | null {
  if (history.length === 0) return null;

  // -- Issue-based metrics --
  const completedIssueCounts = history.map((h) => h.completedIssues);
  const avgCompletedIssues = average(completedIssueCounts);
  const issuePctDiff = percentDiff(current.totalIssues, avgCompletedIssues);
  const issueVerdict = computeRangeVerdict(
    current.totalIssues,
    completedIssueCounts,
  );

  // -- Points-based metrics (null if team doesn't use points) --
  const completedPointsValues = history
    .map((h) => h.completedPoints)
    .filter((v): v is number => v !== null);

  let avgCompletedPoints: number | null = null;
  let pointsPctDiff: number | null = null;
  let pointsVerdict: RangeVerdict | null = null;

  if (completedPointsValues.length > 0 && current.totalPoints !== null) {
    avgCompletedPoints = average(completedPointsValues);
    pointsPctDiff = percentDiff(current.totalPoints, avgCompletedPoints);
    pointsVerdict = computeRangeVerdict(
      current.totalPoints,
      completedPointsValues,
    );
  }

  // -- Over-commitment flag --
  // High points commitment but similar issue count → likely inflated estimates
  let overCommitmentFlag = false;
  if (
    pointsVerdict === "Above recent range" &&
    Math.abs(issuePctDiff) <= OVER_COMMIT_ISSUE_THRESHOLD_PERCENT
  ) {
    overCommitmentFlag = true;
  }

  return {
    history,
    current,
    averageCompletedIssues: Math.round(avgCompletedIssues * 10) / 10,
    averageCompletedPoints:
      avgCompletedPoints !== null
        ? Math.round(avgCompletedPoints * 10) / 10
        : null,
    issuePercentDiff: issuePctDiff,
    pointsPercentDiff: pointsPctDiff,
    issueRangeVerdict: issueVerdict,
    pointsRangeVerdict: pointsVerdict,
    overCommitmentFlag,
  };
}
