import { asApp, asUser, route } from "@forge/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Rovo action event context — every action payload includes this.
 * Mirrors the pattern from forge-rovo-guardrail-sprint/src/forge/events.ts.
 */
interface EventContext {
  cloudId: string;
  moduleKey: string;
  userAccess?: { enabled: boolean };
}

/**
 * When the user triggers an action while viewing a Jira Software board,
 * the Rovo context includes board-specific details under context.jira.
 */
interface JiraBoardDetail {
  boardId: string;
  url: string;
  resourceType: string;
}

export interface RovoBoardContext extends EventContext {
  jira?: JiraBoardDetail;
}

/**
 * The payload shape for the get-board-context action.
 * boardId may come from the user explicitly, or we fall back to context.
 */
export interface GetBoardContextPayload {
  boardId?: number;
  sprintId?: number;
  context: RovoBoardContext;
}

/**
 * Internal request type once we've resolved which board to query.
 * Uses bigint for boardId to match the guardrail pattern.
 */
export interface RequestBoard {
  boardId: bigint;
  context?: RovoBoardContext;
}

// -- API Response Types --

interface BoardLocation {
  projectId: number;
  projectKey: string;
  projectName: string;
  projectTypeKey: string;
  displayName: string;
  name: string;
  userAccountId: string;
  userId: number;
}

export interface BoardResponse {
  id: number;
  name: string;
  self: string;
  type: string;
  location: BoardLocation;
}

/**
 * Standard paginated response shape from the Jira Software REST API.
 */
interface PagedResponse {
  startAt: number;
  maxResults: number;
  total: number;
  isLast?: boolean;
}

export interface SprintResponse {
  id: number;
  self: string;
  state: string;
  name: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
}

export interface SprintResultPage extends PagedResponse {
  values: SprintResponse[];
}

export interface BacklogIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: {
      name: string;
    };
    issuetype: {
      name: string;
    };
    assignee?: {
      displayName: string;
    };
    priority?: {
      name: string;
    };
  };
}

export interface BacklogResultPage extends PagedResponse {
  issues: BacklogIssue[];
}

// ---------------------------------------------------------------------------
// Auth Helper — matches forge-rovo-guardrail-sprint exactly
// ---------------------------------------------------------------------------

/**
 * Determines the correct authentication method for a Forge API call.
 *
 * Uses the direct asUser/asApp imports from @forge/api (not api.asUser()),
 * matching the guardrail pattern. Checks userAccess.enabled from context.
 */
function getAuthForEvent(request: { context?: RovoBoardContext }) {
  if (request.context === undefined) {
    return asApp();
  }
  const c = request.context;
  if (c.userAccess?.enabled) {
    return asUser();
  }
  return asApp();
}

// ---------------------------------------------------------------------------
// Board ID Resolution — matches guardrail pickBoard pattern
// ---------------------------------------------------------------------------

export function pickBoard(
  payload: GetBoardContextPayload,
): RequestBoard | string {
  if (payload.boardId) {
    return {
      boardId: BigInt(payload.boardId),
      context: payload.context,
    };
  }
  if (payload.context?.jira?.boardId) {
    return {
      boardId: BigInt(payload.context.jira.boardId),
      context: payload.context,
    };
  }
  return "Could not find a Board Id in the current context";
}

// ---------------------------------------------------------------------------
// API Functions — mirrors guardrail fetch/list patterns
// ---------------------------------------------------------------------------

/**
 * Fetches basic board details.
 * GET /rest/agile/1.0/board/{boardId}
 */
export async function fetchBoard(
  payload: RequestBoard,
): Promise<BoardResponse> {
  try {
    const apiWithAuth = getAuthForEvent(payload);
    const response = await apiWithAuth.requestJira(
      route`/rest/agile/1.0/board/${payload.boardId.toString()}`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );
    if (response.ok) {
      const responseJson = (await response.json()) as BoardResponse;
      return responseJson;
    }
    console.error(`Failed: Board Id "${payload.boardId}"`);
    throw new Error(`Failed for Board Id "${payload.boardId}"`);
  } catch (error) {
    console.error(error);
    throw new Error(`Failed for Board Id "${payload.boardId}"`);
  }
}

/**
 * Lists sprints for a board filtered by state (active, future, closed).
 * GET /rest/agile/1.0/board/{boardId}/sprint?state={state}
 */
export async function listSprintsForBoard(
  payload: RequestBoard,
  state: "active" | "future" | "closed",
): Promise<SprintResultPage> {
  try {
    const apiWithAuth = getAuthForEvent(payload);
    const response = await apiWithAuth.requestJira(
      route`/rest/agile/1.0/board/${payload.boardId.toString()}/sprint?state=${state}`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );
    if (response.ok) {
      const responseJson = (await response.json()) as SprintResultPage;
      return responseJson;
    }
    // A 404 on sprints likely means this is a kanban board (no sprints).
    if (response.status === 404) {
      return { startAt: 0, maxResults: 0, total: 0, isLast: true, values: [] };
    }
    console.error(`Failed: Board Id "${payload.boardId}"`);
    throw new Error(`Failed for Board Id "${payload.boardId}"`);
  } catch (error) {
    console.error(error);
    throw new Error(`Failed for Board Id "${payload.boardId}"`);
  }
}

/**
 * Fetches a specific sprint by ID.
 * GET /rest/agile/1.0/sprint/{sprintId}
 */
export async function fetchSprint(
  payload: RequestBoard,
  sprintId: number,
): Promise<SprintResponse> {
  try {
    const apiWithAuth = getAuthForEvent(payload);
    const response = await apiWithAuth.requestJira(
      route`/rest/agile/1.0/sprint/${sprintId.toString()}`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );
    if (response.ok) {
      return (await response.json()) as SprintResponse;
    }
    console.error(`Failed: Sprint Id "${sprintId}"`);
    throw new Error(`Failed for Sprint Id "${sprintId}"`);
  } catch (error) {
    console.error(error);
    throw new Error(`Failed for Sprint Id "${sprintId}"`);
  }
}

/**
 * Fetches the backlog for a board — issues not assigned to any sprint.
 * GET /rest/agile/1.0/board/{boardId}/backlog
 */
export async function fetchBoardBacklog(
  payload: RequestBoard,
): Promise<BacklogResultPage> {
  try {
    const apiWithAuth = getAuthForEvent(payload);
    const response = await apiWithAuth.requestJira(
      route`/rest/agile/1.0/board/${payload.boardId.toString()}/backlog`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );
    if (response.ok) {
      const responseJson = (await response.json()) as BacklogResultPage;
      return responseJson;
    }
    // A 400/404 can occur on kanban boards without a backlog enabled.
    if (response.status === 400 || response.status === 404) {
      return { startAt: 0, maxResults: 0, total: 0, issues: [] };
    }
    console.error(`Failed: Backlog for Board Id "${payload.boardId}"`);
    throw new Error(`Failed for Board Id "${payload.boardId}"`);
  } catch (error) {
    console.error(error);
    throw new Error(`Failed for Board Id "${payload.boardId}"`);
  }
}
