import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCarryOverCount,
  assessCarryOverRisk,
  assessIssue,
  parseAssigneeChanges,
  parseEstimateChanges,
  parseSprintAge,
  formatTimeEstimate,
} from "../src/signals";
import type { SearchIssue } from "../src/jira/search";

// ---------------------------------------------------------------------------
// Helper: build a minimal SearchIssue with controlled changelog
// ---------------------------------------------------------------------------

/**
 * Creates a synthetic SearchIssue with the given Sprint changelog entries.
 * Each entry is an object with fromString and toString values for the Sprint field.
 * Entries are ordered newest-first (matching the actual Jira API response order).
 */
function makeIssue(
  key: string,
  sprintChanges: { fromString: string | null; toString: string | null }[],
  otherChanges: { field: string; fromString: string | null; toString: string | null }[] = [],
): SearchIssue {
  const histories = [];

  // Sprint changes — added newest first (index 0 = most recent)
  for (let i = 0; i < sprintChanges.length; i++) {
    const change = sprintChanges[i]!;
    histories.push({
      id: String(i + 1),
      author: { accountId: "test-user", displayName: "Test User" },
      created: `2026-04-0${7 - i}T10:00:00.000+0000`,
      items: [
        {
          field: "Sprint",
          fieldtype: "custom",
          from: null,
          fromString: change.fromString,
          to: null,
          // Use Object.defineProperty to set toString as an own property
          // matching how JSON.parse creates it from the API response
          toString: change.toString,
        },
      ],
    });
  }

  // Other field changes (e.g. assignee, status) — appended after sprint changes
  for (let i = 0; i < otherChanges.length; i++) {
    const change = otherChanges[i]!;
    histories.push({
      id: String(sprintChanges.length + i + 1),
      author: { accountId: "test-user", displayName: "Test User" },
      created: `2026-03-${20 + i}T10:00:00.000+0000`,
      items: [
        {
          field: change.field,
          fieldtype: "jira",
          from: null,
          fromString: change.fromString,
          to: null,
          toString: change.toString,
        },
      ],
    });
  }

  return {
    id: "10001",
    key,
    self: `https://test.atlassian.net/rest/api/3/issue/10001`,
    fields: {
      summary: `Test issue ${key}`,
      status: { name: "To Do", statusCategory: { name: "To Do" } },
      issuetype: { name: "Story" },
      assignee: { displayName: "Test User" },
      priority: { name: "Medium" },
    },
    changelog: {
      startAt: 0,
      maxResults: 100,
      total: histories.length,
      histories,
    },
  } as unknown as SearchIssue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseCarryOverCount", () => {
  // Test 1: 3-sprint carry-over
  it("detects 3-sprint carry-over from cumulative sprint list", () => {
    const issue = makeIssue("TEST-1", [
      // Most recent first
      { fromString: "Sprint 1, Sprint 2", toString: "Sprint 1, Sprint 2, Sprint 3" },
      { fromString: "Sprint 1", toString: "Sprint 1, Sprint 2" },
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseCarryOverCount(issue);
    assert.equal(result.count, 3);
    assert.deepEqual(result.sprintNames, ["Sprint 1", "Sprint 2", "Sprint 3"]);
  });

  // Test 2: No carry-over (single sprint)
  it("returns count=1 for issue placed in a single sprint", () => {
    const issue = makeIssue("TEST-2", [
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseCarryOverCount(issue);
    assert.equal(result.count, 1);
    assert.deepEqual(result.sprintNames, ["Sprint 1"]);
  });

  // Test 3: 2-sprint carry-over
  it("detects 2-sprint carry-over", () => {
    const issue = makeIssue("TEST-3", [
      { fromString: "Sprint 1", toString: "Sprint 1, Sprint 2" },
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseCarryOverCount(issue);
    assert.equal(result.count, 2);
    assert.deepEqual(result.sprintNames, ["Sprint 1", "Sprint 2"]);
  });

  // Test 4: 4-sprint carry-over
  it("detects 4-sprint carry-over — persistent blocker pattern", () => {
    const issue = makeIssue("TEST-4", [
      { fromString: "Sprint 9, Sprint 10, Sprint 11", toString: "Sprint 9, Sprint 10, Sprint 11, Sprint 12" },
      { fromString: "Sprint 9, Sprint 10", toString: "Sprint 9, Sprint 10, Sprint 11" },
      { fromString: "Sprint 9", toString: "Sprint 9, Sprint 10" },
      { fromString: "", toString: "Sprint 9" },
    ]);
    const result = parseCarryOverCount(issue);
    assert.equal(result.count, 4);
    assert.deepEqual(result.sprintNames, ["Sprint 9", "Sprint 10", "Sprint 11", "Sprint 12"]);
  });

  // Test 5: Manual mid-sprint move (Edge Case C)
  // When issue is moved between active sprints without completing the original,
  // the original sprint doesn't persist in the cumulative list
  it("handles manual mid-sprint move — uncompleted sprint not in cumulative list", () => {
    const issue = makeIssue("TEST-5", [
      // Sprint 1 was never completed, so it doesn't appear in the cumulative list
      { fromString: "Sprint 1", toString: "Sprint 2" },
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseCarryOverCount(issue);
    // Only Sprint 2 is in the most recent toString — Sprint 1 was dropped
    assert.equal(result.count, 1);
    assert.deepEqual(result.sprintNames, ["Sprint 2"]);
  });

  // Test 6: Backlog removal + re-add (Edge Case F)
  // Removing to backlog and re-adding resets the sprint trail
  it("handles backlog removal and re-add — history reset", () => {
    const issue = makeIssue("TEST-6", [
      // Re-added: looks like initial placement (from is empty)
      { fromString: "", toString: "Sprint 1" },
      // Removed to backlog
      { fromString: "Sprint 1", toString: null },
      // Initial placement
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseCarryOverCount(issue);
    // Most recent non-null toString is "Sprint 1" — count is 1
    assert.equal(result.count, 1);
    assert.deepEqual(result.sprintNames, ["Sprint 1"]);
  });

  // Test 7: Empty changelog
  it("returns count=1 for issue with empty changelog", () => {
    const issue: SearchIssue = {
      id: "10001",
      key: "TEST-7",
      self: "https://test.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Test issue",
        status: { name: "To Do", statusCategory: { name: "To Do" } },
        issuetype: { name: "Story" },
      },
      changelog: {
        startAt: 0,
        maxResults: 0,
        total: 0,
        histories: [],
      },
    } as unknown as SearchIssue;
    const result = parseCarryOverCount(issue);
    assert.equal(result.count, 1);
    assert.deepEqual(result.sprintNames, []);
  });

  // Test 8: No Sprint field changes in changelog
  it("returns count=1 when changelog has no Sprint field changes", () => {
    const issue = makeIssue("TEST-8", [], [
      { field: "assignee", fromString: null, toString: "Alice" },
      { field: "status", fromString: "To Do", toString: "In Progress" },
      { field: "Story Points", fromString: null, toString: "5" },
    ]);
    const result = parseCarryOverCount(issue);
    assert.equal(result.count, 1);
    assert.deepEqual(result.sprintNames, []);
  });

  // Test 11: toString property extraction from parsed JSON
  // Verifies that the getToString helper correctly reads the "toString"
  // property from an object that was created via JSON.parse (simulating
  // the actual API response parsing)
  it("correctly extracts toString from JSON-parsed changelog items", () => {
    // Simulate what happens when JSON.parse creates the object —
    // the toString property is a real own property, not the prototype method
    const rawJson = JSON.stringify({
      id: "10001",
      key: "TEST-11",
      self: "https://test.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "Test toString extraction",
        status: { name: "To Do", statusCategory: { name: "To Do" } },
        issuetype: { name: "Story" },
      },
      changelog: {
        startAt: 0,
        maxResults: 100,
        total: 4,
        histories: [
          {
            id: "1",
            author: { accountId: "test", displayName: "Test" },
            created: "2026-04-07T10:00:00.000+0000",
            items: [{
              field: "Sprint",
              fieldtype: "custom",
              from: null,
              fromString: "Sprint 9, Sprint 10, Sprint 11",
              to: null,
              toString: "Sprint 9, Sprint 10, Sprint 11, Sprint 12",
            }],
          },
          {
            id: "2",
            author: { accountId: "test", displayName: "Test" },
            created: "2026-04-06T10:00:00.000+0000",
            items: [{
              field: "Sprint",
              fieldtype: "custom",
              from: null,
              fromString: "Sprint 9, Sprint 10",
              to: null,
              toString: "Sprint 9, Sprint 10, Sprint 11",
            }],
          },
          {
            id: "3",
            author: { accountId: "test", displayName: "Test" },
            created: "2026-04-05T10:00:00.000+0000",
            items: [{
              field: "Sprint",
              fieldtype: "custom",
              from: null,
              fromString: "Sprint 9",
              to: null,
              toString: "Sprint 9, Sprint 10",
            }],
          },
          {
            id: "4",
            author: { accountId: "test", displayName: "Test" },
            created: "2026-04-04T10:00:00.000+0000",
            items: [{
              field: "Sprint",
              fieldtype: "custom",
              from: null,
              fromString: "",
              to: null,
              toString: "Sprint 9",
            }],
          },
        ],
      },
    });

    const issue = JSON.parse(rawJson) as SearchIssue;
    const result = parseCarryOverCount(issue);
    assert.equal(result.count, 4);
    assert.deepEqual(result.sprintNames, ["Sprint 9", "Sprint 10", "Sprint 11", "Sprint 12"]);
  });

  // Test 12: Whitespace/formatting in sprint list
  it("handles inconsistent whitespace in sprint list", () => {
    const issue = makeIssue("TEST-12", [
      { fromString: "Sprint 1", toString: "Sprint 1,Sprint 2,  Sprint 3 " },
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseCarryOverCount(issue);
    assert.equal(result.count, 3);
    assert.deepEqual(result.sprintNames, ["Sprint 1", "Sprint 2", "Sprint 3"]);
  });

  // Test 13: Final Sprint entry has to=null (issue removed from sprint)
  // Parser should fall back to the next most recent entry with a non-null toString
  it("falls back to earlier entry when most recent Sprint change has null toString", () => {
    const issue = makeIssue("TEST-13", [
      // Most recent: issue removed from sprint
      { fromString: "Sprint 1, Sprint 2", toString: null },
      // Previous: issue was in 2 sprints
      { fromString: "Sprint 1", toString: "Sprint 1, Sprint 2" },
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseCarryOverCount(issue);
    assert.equal(result.count, 2);
    assert.deepEqual(result.sprintNames, ["Sprint 1", "Sprint 2"]);
  });
});

describe("assessCarryOverRisk", () => {
  // Test 9: Boundary — exactly 3 sprints = High
  it("rates exactly 3 sprints as High risk", () => {
    assert.equal(assessCarryOverRisk(3), "High");
  });

  // Test 10: Boundary — exactly 2 sprints = Medium
  it("rates exactly 2 sprints as Medium risk", () => {
    assert.equal(assessCarryOverRisk(2), "Medium");
  });

  it("rates 1 sprint as Low risk", () => {
    assert.equal(assessCarryOverRisk(1), "Low");
  });

  it("rates 0 sprints as Low risk", () => {
    assert.equal(assessCarryOverRisk(0), "Low");
  });

  it("rates 5+ sprints as High risk", () => {
    assert.equal(assessCarryOverRisk(5), "High");
  });
});

describe("assessIssue", () => {
  it("produces a complete assessment combining parsing and risk rating", () => {
    const issue = makeIssue("TEST-FULL", [
      { fromString: "Sprint 1, Sprint 2", toString: "Sprint 1, Sprint 2, Sprint 3" },
      { fromString: "Sprint 1", toString: "Sprint 1, Sprint 2" },
      { fromString: "", toString: "Sprint 1" },
    ]);
    const assessment = assessIssue(issue);
    assert.equal(assessment.key, "TEST-FULL");
    assert.equal(assessment.sprintCount, 3);
    assert.equal(assessment.risk, "High");
    assert.deepEqual(assessment.sprintNames, ["Sprint 1", "Sprint 2", "Sprint 3"]);
    assert.equal(assessment.type, "Story");
    assert.equal(assessment.status, "To Do");
    assert.equal(assessment.assignee, "Test User");
  });

  it("includes all signal fields in the assessment", () => {
    const issue = makeIssue(
      "TEST-SIGNALS",
      [{ fromString: "", toString: "Sprint 1" }],
      [
        { field: "assignee", fromString: null, toString: "Alice" },
        { field: "Story Points", fromString: "3", toString: "5" },
      ],
    );
    const assessment = assessIssue(issue);
    assert.equal(assessment.assigneeChanges.count, 1);
    assert.equal(assessment.estimateChanges.points.count, 1);
    assert.equal(assessment.sprintAge.firstSprintDate !== null, true);
  });
});

// ---------------------------------------------------------------------------
// parseAssigneeChanges
// ---------------------------------------------------------------------------

describe("parseAssigneeChanges", () => {
  it("returns count 0 when no assignee changes", () => {
    const issue = makeIssue("AC-1", [
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseAssigneeChanges(issue);
    assert.equal(result.count, 0);
    assert.equal(result.changes.length, 0);
  });

  it("returns count 0 for issue with no changelog", () => {
    const issue: SearchIssue = {
      id: "10001",
      key: "AC-2",
      self: "https://test.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "No changelog",
        status: { name: "To Do", statusCategory: { name: "To Do" } },
        issuetype: { name: "Story" },
      },
      changelog: { startAt: 0, maxResults: 100, total: 0, histories: [] },
    } as unknown as SearchIssue;
    const result = parseAssigneeChanges(issue);
    assert.equal(result.count, 0);
  });

  it("counts a single assignee change", () => {
    const issue = makeIssue("AC-3", [], [
      { field: "assignee", fromString: null, toString: "Alice" },
    ]);
    const result = parseAssigneeChanges(issue);
    assert.equal(result.count, 1);
    assert.equal(result.changes[0]!.from, null);
    assert.equal(result.changes[0]!.to, "Alice");
  });

  it("counts multiple reassignments", () => {
    const issue = makeIssue("AC-4", [], [
      { field: "assignee", fromString: "Alice", toString: "Bob" },
      { field: "assignee", fromString: null, toString: "Alice" },
      { field: "assignee", fromString: "Bob", toString: "Charlie" },
    ]);
    const result = parseAssigneeChanges(issue);
    assert.equal(result.count, 3);
    assert.equal(result.changes.length, 3);
  });

  it("ignores non-assignee field changes", () => {
    const issue = makeIssue("AC-5", [], [
      { field: "status", fromString: "To Do", toString: "In Progress" },
      { field: "assignee", fromString: "Alice", toString: "Bob" },
      { field: "priority", fromString: "Medium", toString: "High" },
    ]);
    const result = parseAssigneeChanges(issue);
    assert.equal(result.count, 1);
  });
});

// ---------------------------------------------------------------------------
// parseEstimateChanges
// ---------------------------------------------------------------------------

describe("parseEstimateChanges", () => {
  it("returns empty buckets when no estimate changes", () => {
    const issue = makeIssue("EC-1", [
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.count, 0);
    assert.equal(result.time.count, 0);
    assert.equal(result.totalChanges, 0);
  });

  it("classifies Story Points into points bucket", () => {
    const issue = makeIssue("EC-2", [], [
      { field: "Story Points", fromString: "3", toString: "5" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.count, 1);
    assert.equal(result.points.changes[0]!.field, "Story Points");
    assert.equal(result.points.changes[0]!.from, "3");
    assert.equal(result.points.changes[0]!.to, "5");
    assert.equal(result.time.count, 0);
    assert.equal(result.totalChanges, 1);
  });

  it("classifies story_points into points bucket", () => {
    const issue = makeIssue("EC-3", [], [
      { field: "story_points", fromString: "2", toString: "8" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.count, 1);
  });

  it("classifies timeestimate into time bucket", () => {
    const issue = makeIssue("EC-4", [], [
      { field: "timeestimate", fromString: "3600", toString: "7200" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.time.count, 1);
    assert.equal(result.time.changes[0]!.field, "timeestimate");
    assert.equal(result.points.count, 0);
    assert.equal(result.totalChanges, 1);
  });

  it("classifies Original Estimate into time bucket", () => {
    const issue = makeIssue("EC-5", [], [
      { field: "Original Estimate", fromString: "1h", toString: "2h" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.time.count, 1);
  });

  it("classifies Remaining Estimate into time bucket", () => {
    const issue = makeIssue("EC-6", [], [
      { field: "Remaining Estimate", fromString: "4h", toString: "2h" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.time.count, 1);
  });

  it("classifies timeoriginalestimate into time bucket", () => {
    const issue = makeIssue("EC-7", [], [
      { field: "timeoriginalestimate", fromString: "7200", toString: "14400" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.time.count, 1);
  });

  it("handles mixed points and time changes", () => {
    const issue = makeIssue("EC-8", [], [
      { field: "Story Points", fromString: "3", toString: "5" },
      { field: "timeestimate", fromString: "3600", toString: "7200" },
      { field: "Story Points", fromString: "5", toString: "8" },
      { field: "Original Estimate", fromString: "2h", toString: "4h" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.count, 2);
    assert.equal(result.time.count, 2);
    assert.equal(result.totalChanges, 4);
  });

  it("matches custom fields containing 'point' (case-insensitive)", () => {
    const issue = makeIssue("EC-9", [], [
      { field: "Effort Points", fromString: "1", toString: "3" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.count, 1);
  });

  it("ignores unrelated field changes", () => {
    const issue = makeIssue("EC-10", [], [
      { field: "status", fromString: "To Do", toString: "In Progress" },
      { field: "summary", fromString: "Old title", toString: "New title" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.totalChanges, 0);
  });

  it("computes latestDrift for points value-to-value change", () => {
    const issue = makeIssue("EC-11", [], [
      { field: "Story Points", fromString: "5", toString: "8" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.notEqual(result.points.latestDrift, null);
    assert.equal(result.points.latestDrift!.from, "5");
    assert.equal(result.points.latestDrift!.to, "8");
    assert.equal(result.points.latestDrift!.display, "5 -> 8");
  });

  it("returns null drift for first estimate (from null to value)", () => {
    const issue = makeIssue("EC-12", [], [
      { field: "Story Points", fromString: null, toString: "5" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.latestDrift, null);
  });

  it("returns null drift for estimate removal (from value to null)", () => {
    const issue = makeIssue("EC-13", [], [
      { field: "Story Points", fromString: "5", toString: null },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.latestDrift, null);
  });

  it("returns null drift for empty string from/to", () => {
    const issue = makeIssue("EC-14", [], [
      { field: "Story Points", fromString: "", toString: "3" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.latestDrift, null);
  });

  it("computes latestDrift for time changes in seconds", () => {
    // 3600s = 1h, 7200s = 2h
    const issue = makeIssue("EC-15", [], [
      { field: "timeestimate", fromString: "3600", toString: "7200" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.notEqual(result.time.latestDrift, null);
    assert.equal(result.time.latestDrift!.from, "1h");
    assert.equal(result.time.latestDrift!.to, "2h");
    assert.equal(result.time.latestDrift!.display, "1h -> 2h");
  });

  it("formats time drift with days", () => {
    // 43200s = 12h, 172800s = 2d
    const issue = makeIssue("EC-16", [], [
      { field: "timeestimate", fromString: "43200", toString: "172800" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.notEqual(result.time.latestDrift, null);
    assert.equal(result.time.latestDrift!.display, "12h -> 2d");
  });

  it("uses most recent change for drift when multiple exist", () => {
    // Newest first in changelog order
    const issue = makeIssue("EC-17", [], [
      { field: "Story Points", fromString: "5", toString: "8" },   // most recent
      { field: "Story Points", fromString: "3", toString: "5" },   // older
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.latestDrift!.display, "5 -> 8");
  });

  it("returns null drift when no changes exist", () => {
    const issue = makeIssue("EC-18", [
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.points.latestDrift, null);
    assert.equal(result.time.latestDrift, null);
  });

  it("passes through display strings for time if not parseable as seconds", () => {
    const issue = makeIssue("EC-19", [], [
      { field: "timeestimate", fromString: "2h", toString: "4h" },
    ]);
    const result = parseEstimateChanges(issue);
    assert.equal(result.time.latestDrift!.display, "2h -> 4h");
  });
});

// ---------------------------------------------------------------------------
// formatTimeEstimate
// ---------------------------------------------------------------------------

describe("formatTimeEstimate", () => {
  it("formats seconds to days", () => {
    assert.equal(formatTimeEstimate(86400), "1d");
    assert.equal(formatTimeEstimate(172800), "2d");
  });

  it("formats seconds to hours", () => {
    assert.equal(formatTimeEstimate(3600), "1h");
    assert.equal(formatTimeEstimate(7200), "2h");
    assert.equal(formatTimeEstimate(43200), "12h");
  });

  it("formats seconds to minutes", () => {
    assert.equal(formatTimeEstimate(60), "1m");
    assert.equal(formatTimeEstimate(1800), "30m");
  });

  it("formats small values as seconds", () => {
    assert.equal(formatTimeEstimate(30), "30s");
  });

  it("handles fractional values", () => {
    assert.equal(formatTimeEstimate(5400), "1.5h");
    assert.equal(formatTimeEstimate(129600), "1.5d");
  });
});

// ---------------------------------------------------------------------------
// parseSprintAge
// ---------------------------------------------------------------------------

describe("parseSprintAge", () => {
  // Fix "now" for deterministic tests
  const fixedNow = new Date("2026-04-08T10:00:00.000+0000");

  it("returns null when no changelog", () => {
    const issue: SearchIssue = {
      id: "10001",
      key: "SA-1",
      self: "https://test.atlassian.net/rest/api/3/issue/10001",
      fields: {
        summary: "No changelog",
        status: { name: "To Do", statusCategory: { name: "To Do" } },
        issuetype: { name: "Story" },
      },
      changelog: { startAt: 0, maxResults: 100, total: 0, histories: [] },
    } as unknown as SearchIssue;
    const result = parseSprintAge(issue, fixedNow);
    assert.equal(result.firstSprintDate, null);
    assert.equal(result.ageDays, null);
  });

  it("returns null when no Sprint field changes exist", () => {
    const issue = makeIssue("SA-2", [], [
      { field: "status", fromString: "To Do", toString: "In Progress" },
    ]);
    const result = parseSprintAge(issue, fixedNow);
    assert.equal(result.firstSprintDate, null);
    assert.equal(result.ageDays, null);
  });

  it("returns null when Sprint changes have non-empty fromString (moved between sprints only)", () => {
    const issue = makeIssue("SA-3", [
      { fromString: "Sprint 1", toString: "Sprint 1, Sprint 2" },
    ]);
    const result = parseSprintAge(issue, fixedNow);
    assert.equal(result.firstSprintDate, null);
    assert.equal(result.ageDays, null);
  });

  it("finds first sprint assignment and calculates age", () => {
    // makeIssue creates newest-first histories, dates count back from April 7
    // Entry with fromString="" is the first sprint assignment
    const issue = makeIssue("SA-4", [
      { fromString: "Sprint 1", toString: "Sprint 1, Sprint 2" },
      { fromString: "", toString: "Sprint 1" },
    ]);
    const result = parseSprintAge(issue, fixedNow);
    // Second entry (index 1) gets date 2026-04-06T10:00:00.000+0000
    assert.equal(result.firstSprintDate, "2026-04-06T10:00:00.000+0000");
    assert.equal(result.ageDays, 2);
  });

  it("finds the earliest first-assignment when multiple exist", () => {
    // Scenario: issue removed from sprint and re-added (backlog reset)
    // Both entries have fromString="" but we want the earliest one
    const issue = makeIssue("SA-5", [
      { fromString: "", toString: "Sprint 3" },          // newest — April 7
      { fromString: "Sprint 1", toString: "Sprint 1, Sprint 2" },  // April 6
      { fromString: "", toString: "Sprint 1" },           // oldest — April 5
    ]);
    const result = parseSprintAge(issue, fixedNow);
    assert.equal(result.firstSprintDate, "2026-04-05T10:00:00.000+0000");
    assert.equal(result.ageDays, 3);
  });

  it("handles null fromString as first assignment", () => {
    const issue = makeIssue("SA-6", [
      { fromString: null, toString: "Sprint 1" },
    ]);
    const result = parseSprintAge(issue, fixedNow);
    assert.notEqual(result.firstSprintDate, null);
    assert.equal(typeof result.ageDays, "number");
  });
});
