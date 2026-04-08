import {
  type GetBoardContextPayload,
  pickBoard,
  fetchSprint,
  listSprintsForBoard,
} from "./jira/software/board";
import { searchIssuesWithChangelog } from "./jira/search";
import {
  makeErrorResponse,
  toSprintIssueSummary,
  toSprintSummary,
  type ActionResponse,
  type SprintIssuesResponse,
  type SprintSelectionResponse,
} from "./responses";

/**
 * Action handler for the get-sprint-issues action.
 *
 * If sprintId is provided, fetches issues for that specific sprint.
 * If not, returns a list of available sprints (active + future)
 * for the user to choose from.
 */
export async function getSprintIssues(
  payload: GetBoardContextPayload,
): Promise<ActionResponse> {
  const boardRequest = pickBoard(payload);
  if (typeof boardRequest === "string") {
    return makeErrorResponse("get-sprint-issues", "MISSING_BOARD_ID", boardRequest);
  }

  try {
    // If sprintId provided, fetch that sprint directly
    if (payload.sprintId) {
      const sprint = await fetchSprint(boardRequest, payload.sprintId);
      return fetchIssuesForSprint(sprint, payload);
    }

    // Otherwise, list available sprints for user selection
    const [activeSprints, futureSprints] = await Promise.all([
      listSprintsForBoard(boardRequest, "active"),
      listSprintsForBoard(boardRequest, "future"),
    ]);

    const allSprints = [...activeSprints.values, ...futureSprints.values];

    if (allSprints.length === 0) {
      return makeErrorResponse(
        "get-sprint-issues",
        "NO_SPRINTS",
        "No active or future sprints found for this board.",
      );
    }

    const response: SprintSelectionResponse = {
      ok: true,
      action: "get-sprint-issues",
      selectionRequired: true,
      data: {
        availableSprints: allSprints.map(toSprintSummary),
      },
    };
    return response;
  } catch (error) {
    console.error("Failed to fetch sprint issues:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return makeErrorResponse(
      "get-sprint-issues",
      "REQUEST_FAILED",
      `Error retrieving sprint issues: ${message}`,
    );
  }
}

async function fetchIssuesForSprint(
  sprint: Parameters<typeof toSprintSummary>[0],
  payload: GetBoardContextPayload,
): Promise<ActionResponse> {
  const jql = `sprint = ${sprint.id} ORDER BY rank ASC`;
  const issues = await searchIssuesWithChangelog({
    jql,
    context: payload.context,
  });

  if (issues.length === 0) {
    return makeErrorResponse(
      "get-sprint-issues",
      "NO_ISSUES",
      `No issues found in sprint "${sprint.name}".`,
    );
  }

  return buildSprintIssuesResponse(sprint, issues);
}

function buildSprintIssuesResponse(
  sprint: Parameters<typeof toSprintSummary>[0],
  issues: Parameters<typeof toSprintIssueSummary>[0][],
): SprintIssuesResponse {
  return {
    ok: true,
    action: "get-sprint-issues",
    data: {
      sprint: toSprintSummary(sprint),
      totalIssues: issues.length,
      issues: issues.map(toSprintIssueSummary),
    },
  };
}
