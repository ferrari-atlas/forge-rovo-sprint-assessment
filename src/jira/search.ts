import { asApp, asUser, route } from "@forge/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context from the Rovo action payload — needed for auth decisions.
 * Duplicated from board.ts to avoid circular dependencies.
 * TODO: extract to a shared types module if more files need this.
 */
interface EventContext {
  cloudId: string;
  moduleKey: string;
  userAccess?: { enabled: boolean };
}

/**
 * A single field change within a changelog entry.
 * Each item represents one field that was modified in a single edit.
 *
 * Key fields for sprint assessment:
 * - field="Sprint": sprint assignment changes (to value is comma-separated list of all sprints)
 * - field="assignee": assignee changes
 * - field="Story Points" / "timeestimate" / "Original Estimate": estimate changes
 * - field="status": status transitions
 * - field="Flagged": impediment flag changes
 */
export interface ChangelogItem {
  field: string;
  fieldtype: string;
  fieldId?: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

/**
 * A single changelog entry — one edit event that may change multiple fields.
 * Each entry records who made the change, when, and what changed.
 */
export interface ChangelogEntry {
  id: string;
  author: {
    accountId: string;
    displayName: string;
  };
  created: string;
  items: ChangelogItem[];
}

/**
 * The changelog block as returned when expanding changelog on an issue.
 * Capped at ~100 most recent entries (no pagination within the expand).
 */
export interface IssueChangelog {
  startAt: number;
  maxResults: number;
  total: number;
  histories: ChangelogEntry[];
}

/**
 * The issue fields we request in the search.
 * Kept minimal — just enough to identify the issue and its current state.
 */
export interface SearchIssueFields {
  summary: string;
  status: {
    name: string;
    statusCategory: {
      name: string;
    };
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
  flagged?: boolean;
}

/**
 * A single issue from the search response, including changelog.
 */
export interface SearchIssue {
  id: string;
  key: string;
  self: string;
  fields: SearchIssueFields;
  changelog: IssueChangelog;
}

/**
 * Search response from the Jira REST API (/rest/api/3/search/jql).
 * This newer endpoint returns { issues, isLast } — no total, startAt, or maxResults.
 */
export interface SearchResponse {
  issues: SearchIssue[];
  isLast?: boolean;
}

/**
 * Request type for the search function.
 */
export interface SearchRequest {
  jql: string;
  context?: EventContext;
}

// ---------------------------------------------------------------------------
// Auth Helper
// ---------------------------------------------------------------------------

function getAuthForSearch(request: { context?: EventContext }) {
  if (request.context === undefined) {
    return asApp();
  }
  if (request.context.userAccess?.enabled) {
    return asUser();
  }
  return asApp();
}

// ---------------------------------------------------------------------------
// API Function
// ---------------------------------------------------------------------------

/**
 * Searches for issues using JQL with changelog expanded.
 *
 * Uses GET /rest/api/3/search with expand=changelog to retrieve issues
 * and their change history in a single request. The changelog expand
 * returns up to ~100 most recent entries per issue.
 *
 * Fetches all pages if results exceed maxResults.
 */
export async function searchIssuesWithChangelog(
  request: SearchRequest,
  fields: string = "summary,status,issuetype,assignee,priority,flagged",
): Promise<SearchIssue[]> {
  const allIssues: SearchIssue[] = [];
  let startAt = 0;
  const maxResults = 50;
  let hasMore = true;

  while (hasMore) {
    const apiWithAuth = getAuthForSearch(request);
    const response = await apiWithAuth.requestJira(
      route`/rest/api/3/search/jql?jql=${request.jql}&expand=changelog&fields=${fields}&startAt=${startAt.toString()}&maxResults=${maxResults.toString()}`,
      {
        headers: {
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `JQL search failed: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as SearchResponse;

    const issues = result.issues ?? [];
    allIssues.push(...issues);

    // The /search/jql endpoint uses isLast to signal end of results
    if (result.isLast !== false || issues.length === 0) {
      hasMore = false;
    } else {
      startAt += maxResults;
    }
  }

  return allIssues;
}
