import {
  type GetBoardContextPayload,
  type RequestBoard,
  type SprintResponse,
  pickBoard,
  fetchSprint,
  listSprintsForBoard,
  fetchSprintReport,
} from "./jira/software/board";
import { searchIssuesWithChangelog } from "./jira/search";
import { type IssueAssessment, assessIssue } from "./signals";
import {
  makeErrorResponse,
  toSprintSummary,
  type ActionResponse,
  type SprintAssessmentResponse,
  type SprintSelectionResponse,
} from "./responses";
import { evaluateAllRules, parseConfigOverride } from "./rules";
import {
  type VelocitySignal,
  parseSprintReport,
  computeVelocitySignal,
} from "./velocity";

/**
 * Action handler for the assess-sprint action.
 *
 * If sprintId is provided, assesses that specific sprint.
 * If not, returns a list of available sprints (active + future)
 * for the user to choose from.
 */
export async function assessSprint(
  payload: GetBoardContextPayload,
): Promise<ActionResponse> {
  const boardRequest = pickBoard(payload);
  if (typeof boardRequest === "string") {
    return makeErrorResponse("assess-sprint", "MISSING_BOARD_ID", boardRequest);
  }

  try {
    // If sprintId provided, fetch that sprint directly and run assessment
    if (payload.sprintId) {
      const sprint = await fetchSprint(boardRequest, payload.sprintId);
      const config = parseConfigOverride((payload as any).config);
      return runAssessment(sprint, payload, config);
    }

    // Otherwise, list available sprints for user selection
    const [activeSprints, futureSprints] = await Promise.all([
      listSprintsForBoard(boardRequest, "active"),
      listSprintsForBoard(boardRequest, "future"),
    ]);

    const allSprints = [...activeSprints.values, ...futureSprints.values];

    if (allSprints.length === 0) {
      return makeErrorResponse(
        "assess-sprint",
        "NO_SPRINTS",
        "No active or future sprints found for this board.",
      );
    }

    // Return available sprints for user to pick
    const response: SprintSelectionResponse = {
      ok: true,
      action: "assess-sprint",
      selectionRequired: true,
      data: {
        availableSprints: allSprints.map(toSprintSummary),
      },
    };
    return response;
  } catch (error) {
    console.error("Failed to assess sprint:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return makeErrorResponse(
      "assess-sprint",
      "REQUEST_FAILED",
      `Error assessing sprint: ${message}`,
    );
  }
}

async function runAssessment(
  sprint: SprintResponse,
  payload: GetBoardContextPayload,
  config?: import("./rules").AssessmentConfig,
): Promise<ActionResponse> {
  const boardRequest = pickBoard(payload);

  // Kick off issue search and velocity data fetch in parallel
  const jql = `sprint = ${sprint.id} ORDER BY rank ASC`;
  const [issues, velocitySignal] = await Promise.all([
    searchIssuesWithChangelog({ jql, context: payload.context }),
    typeof boardRequest !== "string"
      ? fetchVelocitySignal(boardRequest, sprint.id)
      : Promise.resolve(null),
  ]);

  if (issues.length === 0) {
    return makeErrorResponse(
      "assess-sprint",
      "NO_ISSUES",
      `No issues found in sprint "${sprint.name}".`,
    );
  }

  const capped = issues.length > 100;
  const issuesToAssess = capped ? issues.slice(0, 100) : issues;
  const assessments = issuesToAssess.map(assessIssue);

  return buildAssessmentResponse(
    sprint,
    assessments,
    capped,
    issues.length,
    config,
    velocitySignal,
  );
}

/**
 * Fetches velocity context: the last 3 closed sprints' sprint reports
 * and the current sprint's report, then computes a VelocitySignal.
 *
 * Returns null if no closed sprints are available or if any fetch fails.
 *
 * NOTE: listSprintsForBoard("closed") returns at most 50 sprints (API default).
 * For boards with >50 closed sprints the most recent 3 may be missed.
 */
async function fetchVelocitySignal(
  boardRequest: RequestBoard,
  currentSprintId: number,
): Promise<VelocitySignal | null> {
  try {
    const closedPage = await listSprintsForBoard(boardRequest, "closed");

    if (closedPage.values.length === 0) return null;

    // Warn if results may be truncated
    if (closedPage.values.length === closedPage.maxResults) {
      console.warn(
        `[velocity] Closed sprint list may be truncated (${closedPage.values.length} returned, maxResults=${closedPage.maxResults}). ` +
          "Historical velocity may not reflect the most recent sprints.",
      );
    }

    // Sort by ID descending (sprint IDs are monotonically increasing) and take last 3
    const sorted = [...closedPage.values].sort((a, b) => b.id - a.id);
    const recentClosed = sorted.slice(0, 3);

    // Fetch sprint reports in parallel: 3 historical + 1 current
    const reportPromises = [
      ...recentClosed.map((s) => fetchSprintReport(boardRequest, s.id)),
      fetchSprintReport(boardRequest, currentSprintId),
    ];
    const reports = await Promise.all(reportPromises);

    const historicalReports = reports.slice(0, recentClosed.length);
    const currentReport = reports[reports.length - 1]!;

    const history = historicalReports.map(parseSprintReport);
    const currentData = parseSprintReport(currentReport);

    return computeVelocitySignal(history, {
      totalIssues: currentData.totalIssues,
      totalPoints: currentData.totalPoints,
    });
  } catch (err) {
    console.error("[velocity] Failed to compute velocity signal:", err);
    return null;
  }
}

export function buildAssessmentResponse(
  sprint: SprintResponse,
  assessments: IssueAssessment[],
  capped: boolean,
  totalIssueCount: number,
  config?: import("./rules").AssessmentConfig,
  velocitySignal?: VelocitySignal | null,
): SprintAssessmentResponse {
  const highRisk = assessments.filter((a) => a.risk === "High").length;
  const mediumRisk = assessments.filter((a) => a.risk === "Medium").length;
  const lowRisk = assessments.filter((a) => a.risk === "Low").length;

  const sprintSummary = toSprintSummary(sprint);
  const rules = evaluateAllRules({
    sprint: sprintSummary,
    issues: assessments,
    config,
    velocitySignal,
  });

  const data: import("./responses").SprintAssessmentData = {
    sprint: sprintSummary,
    summary: {
      assessedIssueCount: assessments.length,
      totalIssueCount,
      capped,
      riskCounts: {
        high: highRisk,
        medium: mediumRisk,
        low: lowRisk,
      },
    },
    rules,
    issues: assessments,
  };

  if (velocitySignal) {
    data.velocityContext = velocitySignal;
  }

  return {
    ok: true,
    action: "assess-sprint",
    data,
  };
}
