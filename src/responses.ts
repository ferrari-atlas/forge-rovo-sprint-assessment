import type { SearchIssue } from "./jira/search";
import type {
  BacklogIssue,
  BoardResponse,
  SprintResponse,
} from "./jira/software/board";
import type { IssueAssessment } from "./signals";
import type { RuleResult } from "./rules";

export interface ActionErrorResponse {
  ok: false;
  action: "get-board-context" | "get-sprint-issues" | "assess-sprint" | "explain-drift";
  error: {
    code:
      | "MISSING_BOARD_ID"
      | "MISSING_ISSUE_KEY"
      | "NO_SPRINTS"
      | "NO_ISSUES"
      | "REQUEST_FAILED";
    message: string;
  };
}

/** A scope-related changelog entry near an estimate change. */
export interface ScopeChangeEntry {
  field: "summary" | "description";
  date: string;
  author: string;
  /** For summary changes, the previous value. Null for description changes. */
  from: string | null;
  /** For summary changes, the new value. Null for description changes. */
  to: string | null;
}

export interface ExplainDriftData {
  issueKey: string;
  issueSummary: string;
  lastEstimateChangeDate: string | null;
  lastEstimateDrift: string | null;
  scopeChanges: ScopeChangeEntry[];
}

export interface ExplainDriftResponse {
  ok: true;
  action: "explain-drift";
  data: ExplainDriftData;
}

export interface SprintSelectionResponse {
  ok: true;
  action: "get-sprint-issues" | "assess-sprint";
  selectionRequired: true;
  data: {
    availableSprints: SprintSummary[];
  };
}

export interface BoardSummary {
  id: number;
  name: string;
  type: string;
  projectKey: string;
  projectName: string;
  url: string;
}

export interface SprintSummary {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  goal?: string;
}

export interface BacklogIssueSummary {
  key: string;
  summary: string;
  type: string;
  status: string;
  assignee: string;
  priority: string;
}

export interface BoardContextData {
  board: BoardSummary;
  activeSprints: SprintSummary[];
  futureSprints: SprintSummary[];
  backlog: {
    total: number;
    issues: BacklogIssueSummary[];
  };
}

export interface BoardContextResponse {
  ok: true;
  action: "get-board-context";
  data: BoardContextData;
}

export interface IssueFieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface IssueChangelogEntrySummary {
  id: string;
  author: string;
  created: string;
  items: IssueFieldChange[];
}

export interface SprintIssueSummary {
  key: string;
  summary: string;
  type: string;
  status: string;
  assignee: string;
  priority: string;
  changelogTotal: number;
  changelogReturned: number;
  changelog: IssueChangelogEntrySummary[];
}

export interface SprintIssuesData {
  sprint: SprintSummary;
  totalIssues: number;
  issues: SprintIssueSummary[];
}

export interface SprintIssuesResponse {
  ok: true;
  action: "get-sprint-issues";
  data: SprintIssuesData;
}

export interface SprintAssessmentSummary {
  assessedIssueCount: number;
  totalIssueCount: number;
  capped: boolean;
  riskCounts: {
    high: number;
    medium: number;
    low: number;
  };
}

export interface SprintAssessmentIssue extends IssueAssessment {}

export interface SprintAssessmentData {
  sprint: SprintSummary;
  summary: SprintAssessmentSummary;
  rules: RuleResult[];
  issues: SprintAssessmentIssue[];
}

export interface SprintAssessmentResponse {
  ok: true;
  action: "assess-sprint";
  data: SprintAssessmentData;
}

export type ActionResponse =
  | BoardContextResponse
  | SprintIssuesResponse
  | SprintAssessmentResponse
  | SprintSelectionResponse
  | ExplainDriftResponse
  | ActionErrorResponse;

export function makeErrorResponse(
  action: ActionErrorResponse["action"],
  code: ActionErrorResponse["error"]["code"],
  message: string,
): ActionErrorResponse {
  return {
    ok: false,
    action,
    error: { code, message },
  };
}

export function toSprintSummary(sprint: SprintResponse): SprintSummary {
  return {
    id: sprint.id,
    name: sprint.name,
    state: sprint.state,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    completeDate: sprint.completeDate,
    goal: sprint.goal,
  };
}

export function toBoardSummary(board: BoardResponse): BoardSummary {
  return {
    id: board.id,
    name: board.name,
    type: board.type,
    projectKey: board.location.projectKey,
    projectName: board.location.projectName,
    url: board.self,
  };
}

export function toBacklogIssueSummary(issue: BacklogIssue): BacklogIssueSummary {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    type: issue.fields.issuetype.name,
    status: issue.fields.status.name,
    assignee: issue.fields.assignee?.displayName ?? "Unassigned",
    priority: issue.fields.priority?.name ?? "-",
  };
}

export function toSprintIssueSummary(issue: SearchIssue): SprintIssueSummary {
  return {
    key: issue.key,
    summary: issue.fields.summary,
    type: issue.fields.issuetype.name,
    status: issue.fields.status.name,
    assignee: issue.fields.assignee?.displayName ?? "Unassigned",
    priority: issue.fields.priority?.name ?? "-",
    changelogTotal: issue.changelog?.total ?? issue.changelog?.histories?.length ?? 0,
    changelogReturned: issue.changelog?.histories?.length ?? 0,
    changelog: (issue.changelog?.histories ?? []).map((entry) => ({
      id: entry.id,
      author: entry.author.displayName,
      created: entry.created,
      items: entry.items.map((item) => ({
        field: item.field,
        from: item.fromString ?? item.from,
        to: item.toString ?? item.to,
      })),
    })),
  };
}
