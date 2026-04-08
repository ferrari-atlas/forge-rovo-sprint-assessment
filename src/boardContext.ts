import {
  type GetBoardContextPayload,
  pickBoard,
  fetchBoard,
  listSprintsForBoard,
  fetchBoardBacklog,
} from "./jira/software/board";
import {
  makeErrorResponse,
  toBacklogIssueSummary,
  toBoardSummary,
  toSprintSummary,
  type ActionResponse,
  type BoardContextResponse,
} from "./responses";

/**
 * Main action handler for the get-board-context action.
 *
 * Returns a structured summary of the board, its active/future sprints,
 * and backlog so the prompt can control presentation.
 */
export async function getBoardContext(
  payload: GetBoardContextPayload,
): Promise<ActionResponse> {
  const boardRequest = pickBoard(payload);
  if (typeof boardRequest === "string") {
    return makeErrorResponse("get-board-context", "MISSING_BOARD_ID", boardRequest);
  }

  try {
    const [board, activeSprints, futureSprints, backlog] = await Promise.all([
      fetchBoard(boardRequest),
      listSprintsForBoard(boardRequest, "active"),
      listSprintsForBoard(boardRequest, "future"),
      fetchBoardBacklog(boardRequest),
    ]);

    return buildBoardContextResponse(board, activeSprints.values, futureSprints.values, backlog);
  } catch (error) {
    console.error("Failed to fetch board context:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return makeErrorResponse(
      "get-board-context",
      "REQUEST_FAILED",
      `Error retrieving board context: ${message}`,
    );
  }
}

function buildBoardContextResponse(
  board: Parameters<typeof toBoardSummary>[0],
  activeSprints: Parameters<typeof toSprintSummary>[0][],
  futureSprints: Parameters<typeof toSprintSummary>[0][],
  backlog: { total: number; issues: Parameters<typeof toBacklogIssueSummary>[0][] },
): BoardContextResponse {
  return {
    ok: true,
    action: "get-board-context",
    data: {
      board: toBoardSummary(board),
      activeSprints: activeSprints.map(toSprintSummary),
      futureSprints: futureSprints.map(toSprintSummary),
      backlog: {
        total: backlog.total,
        issues: backlog.issues.map(toBacklogIssueSummary),
      },
    },
  };
}
