import {
  type GetBoardContextPayload,
  type SprintResponse,
  pickBoard,
  fetchSprint,
  listSprintsForBoard,
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
  const jql = `sprint = ${sprint.id} ORDER BY rank ASC`;
  const issues = await searchIssuesWithChangelog({
    jql,
    context: payload.context,
  });

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

  return buildAssessmentResponse(sprint, assessments, capped, issues.length, config);
}

export function buildAssessmentResponse(
  sprint: SprintResponse,
  assessments: IssueAssessment[],
  capped: boolean,
  totalIssueCount: number,
  config?: import("./rules").AssessmentConfig,
): SprintAssessmentResponse {
  const highRisk = assessments.filter((a) => a.risk === "High").length;
  const mediumRisk = assessments.filter((a) => a.risk === "Medium").length;
  const lowRisk = assessments.filter((a) => a.risk === "Low").length;

  const sprintSummary = toSprintSummary(sprint);
  const rules = config
    ? evaluateAllRules(sprintSummary, assessments, config)
    : evaluateAllRules(sprintSummary, assessments);

  return {
    ok: true,
    action: "assess-sprint",
    data: {
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
    },
  };
}
