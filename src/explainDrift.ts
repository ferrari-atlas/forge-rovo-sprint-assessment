import { searchIssuesWithChangelog } from "./jira/search";
import type { SearchIssue, ChangelogItem } from "./jira/search";
import type { GetBoardContextPayload } from "./jira/software/board";
import {
  makeErrorResponse,
  type ActionResponse,
  type ExplainDriftResponse,
  type ScopeChangeEntry,
} from "./responses";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExplainDriftPayload extends GetBoardContextPayload {
  issueKey?: string;
}

// ---------------------------------------------------------------------------
// Scope Change Parsing
// ---------------------------------------------------------------------------

/**
 * Extracts summary and description changelog entries from an issue.
 *
 * For summary changes: includes the full from/to text (short strings).
 * For description changes: includes date and author only (no ADF content).
 */
export function parseScopeChanges(issue: SearchIssue): ScopeChangeEntry[] {
  const changes: ScopeChangeEntry[] = [];

  if (!issue.changelog?.histories) return changes;

  for (const entry of issue.changelog.histories) {
    for (const item of entry.items) {
      if (item.field === "summary") {
        changes.push({
          field: "summary",
          date: entry.created,
          author: entry.author.displayName,
          from: item.fromString ?? item.from ?? null,
          to: getToString(item) ?? item.to ?? null,
        });
      } else if (item.field === "description") {
        changes.push({
          field: "description",
          date: entry.created,
          author: entry.author.displayName,
          from: item.fromString ?? item.from ?? null,
          to: getToString(item) ?? item.to ?? null,
        });
      }
    }
  }

  return changes;
}

/**
 * Finds the date of the most recent estimate change in the changelog.
 * Looks for point and time estimate fields using the same patterns
 * as the main signals parser.
 */
export function findLastEstimateChangeDate(issue: SearchIssue): {
  date: string | null;
  display: string | null;
} {
  if (!issue.changelog?.histories) return { date: null, display: null };

  const ESTIMATE_PATTERNS = [
    /^story\s*points$/i,
    /point/i,
    /^timeestimate$/i,
    /^timeoriginalestimate$/i,
    /^original\s*estimate$/i,
    /^remaining\s*estimate$/i,
    /time.*estimate/i,
    /estimate.*time/i,
  ];

  for (const entry of issue.changelog.histories) {
    for (const item of entry.items) {
      if (ESTIMATE_PATTERNS.some((p) => p.test(item.field))) {
        const fromVal = item.fromString ?? item.from ?? "";
        const toVal = getToString(item) ?? item.to ?? "";
        return {
          date: entry.created,
          display: `${fromVal} -> ${toVal}`,
        };
      }
    }
  }

  return { date: null, display: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToString(item: ChangelogItem): string | null {
  return (item as unknown as Record<string, string | null>)["toString"] ?? null;
}

// ---------------------------------------------------------------------------
// Action Handler
// ---------------------------------------------------------------------------

/**
 * Action handler for the explain-drift action.
 *
 * Fetches a single issue with its changelog, extracts scope changes
 * (summary and description edits) and the last estimate change date,
 * then returns the structured data for the LLM to assess probable cause.
 */
export async function explainDrift(
  payload: ExplainDriftPayload,
): Promise<ActionResponse> {
  if (!payload.issueKey) {
    return makeErrorResponse(
      "explain-drift",
      "MISSING_ISSUE_KEY",
      "An issue key is required to explain estimate drift.",
    );
  }

  try {
    const jql = `key = "${payload.issueKey}"`;
    const issues = await searchIssuesWithChangelog({
      jql,
      context: payload.context,
    });

    if (issues.length === 0) {
      return makeErrorResponse(
        "explain-drift",
        "NO_ISSUES",
        `Issue "${payload.issueKey}" not found.`,
      );
    }

    const issue = issues[0]!;
    const scopeChanges = parseScopeChanges(issue);
    const lastEstimate = findLastEstimateChangeDate(issue);

    const response: ExplainDriftResponse = {
      ok: true,
      action: "explain-drift",
      data: {
        issueKey: issue.key,
        issueSummary: issue.fields.summary,
        lastEstimateChangeDate: lastEstimate.date,
        lastEstimateDrift: lastEstimate.display,
        scopeChanges,
      },
    };

    return response;
  } catch (error) {
    console.error("Failed to explain drift:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return makeErrorResponse(
      "explain-drift",
      "REQUEST_FAILED",
      `Error explaining drift for "${payload.issueKey}": ${message}`,
    );
  }
}
