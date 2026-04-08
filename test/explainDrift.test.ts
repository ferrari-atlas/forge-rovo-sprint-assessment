import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseScopeChanges, findLastEstimateChangeDate } from "../src/explainDrift";
import type { SearchIssue } from "../src/jira/search";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
  key: string,
  changes: Array<{
    field: string;
    fromString: string | null;
    toString: string | null;
    date?: string;
    author?: string;
  }>,
): SearchIssue {
  const baseDate = new Date("2026-04-07T10:00:00.000+0000");
  const histories = changes.map((c, i) => ({
    id: String(1000 + i),
    author: {
      accountId: "abc",
      displayName: c.author ?? "Dev",
    },
    created: c.date ?? new Date(baseDate.getTime() - i * 86400000).toISOString().replace("Z", "+0000"),
    items: [
      {
        field: c.field,
        fieldtype: "jira",
        from: null,
        fromString: c.fromString,
        to: null,
        toString: c.toString,
      },
    ],
  }));

  return {
    id: "10001",
    key,
    self: `https://test.atlassian.net/rest/api/3/issue/10001`,
    fields: {
      summary: "Test issue",
      status: { name: "To Do", statusCategory: { name: "To Do" } },
      issuetype: { name: "Story" },
      assignee: { displayName: "Dev" },
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
// parseScopeChanges
// ---------------------------------------------------------------------------

describe("parseScopeChanges", () => {
  it("returns empty array when no changelog", () => {
    const issue = {
      id: "1",
      key: "SC-1",
      self: "https://test.atlassian.net/rest/api/3/issue/1",
      fields: {
        summary: "No changelog",
        status: { name: "To Do", statusCategory: { name: "To Do" } },
        issuetype: { name: "Story" },
      },
      changelog: { startAt: 0, maxResults: 100, total: 0, histories: [] },
    } as unknown as SearchIssue;
    const result = parseScopeChanges(issue);
    assert.equal(result.length, 0);
  });

  it("extracts summary changes with full from/to", () => {
    const issue = makeIssue("SC-2", [
      { field: "summary", fromString: "Old title", toString: "New title" },
    ]);
    const result = parseScopeChanges(issue);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.field, "summary");
    assert.equal(result[0]!.from, "Old title");
    assert.equal(result[0]!.to, "New title");
    assert.equal(result[0]!.author, "Dev");
  });

  it("extracts description changes with full content", () => {
    const issue = makeIssue("SC-3", [
      { field: "description", fromString: "old ADF blob", toString: "new ADF blob" },
    ]);
    const result = parseScopeChanges(issue);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.field, "description");
    assert.equal(result[0]!.from, "old ADF blob");
    assert.equal(result[0]!.to, "new ADF blob");
    assert.notEqual(result[0]!.date, null);
  });

  it("extracts both summary and description changes", () => {
    const issue = makeIssue("SC-4", [
      { field: "summary", fromString: "A", toString: "B" },
      { field: "description", fromString: "X", toString: "Y" },
    ]);
    const result = parseScopeChanges(issue);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.field, "summary");
    assert.equal(result[1]!.field, "description");
  });

  it("ignores non-scope fields", () => {
    const issue = makeIssue("SC-5", [
      { field: "status", fromString: "To Do", toString: "In Progress" },
      { field: "assignee", fromString: "Alice", toString: "Bob" },
      { field: "summary", fromString: "A", toString: "B" },
    ]);
    const result = parseScopeChanges(issue);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.field, "summary");
  });

  it("preserves author name from changelog entry", () => {
    const issue = makeIssue("SC-6", [
      { field: "summary", fromString: "A", toString: "B", author: "Product Owner" },
    ]);
    const result = parseScopeChanges(issue);
    assert.equal(result[0]!.author, "Product Owner");
  });
});

// ---------------------------------------------------------------------------
// findLastEstimateChangeDate
// ---------------------------------------------------------------------------

describe("findLastEstimateChangeDate", () => {
  it("returns null when no changelog", () => {
    const issue = {
      id: "1",
      key: "ED-1",
      self: "https://test.atlassian.net/rest/api/3/issue/1",
      fields: {
        summary: "No changelog",
        status: { name: "To Do", statusCategory: { name: "To Do" } },
        issuetype: { name: "Story" },
      },
      changelog: { startAt: 0, maxResults: 100, total: 0, histories: [] },
    } as unknown as SearchIssue;
    const result = findLastEstimateChangeDate(issue);
    assert.equal(result.date, null);
    assert.equal(result.display, null);
  });

  it("returns null when no estimate changes exist", () => {
    const issue = makeIssue("ED-2", [
      { field: "status", fromString: "To Do", toString: "In Progress" },
    ]);
    const result = findLastEstimateChangeDate(issue);
    assert.equal(result.date, null);
  });

  it("finds Story Points change date", () => {
    const date = "2026-04-05T10:00:00.000+0000";
    const issue = makeIssue("ED-3", [
      { field: "Story Points", fromString: "3", toString: "8", date },
    ]);
    const result = findLastEstimateChangeDate(issue);
    assert.equal(result.date, date);
    assert.equal(result.display, "3 -> 8");
  });

  it("finds timeestimate change date", () => {
    const date = "2026-04-04T10:00:00.000+0000";
    const issue = makeIssue("ED-4", [
      { field: "timeestimate", fromString: "3600", toString: "7200", date },
    ]);
    const result = findLastEstimateChangeDate(issue);
    assert.equal(result.date, date);
  });

  it("returns the most recent estimate change when multiple exist", () => {
    const issue = makeIssue("ED-5", [
      { field: "Story Points", fromString: "5", toString: "8", date: "2026-04-07T10:00:00.000+0000" },
      { field: "Story Points", fromString: "3", toString: "5", date: "2026-04-03T10:00:00.000+0000" },
    ]);
    const result = findLastEstimateChangeDate(issue);
    assert.equal(result.date, "2026-04-07T10:00:00.000+0000");
    assert.equal(result.display, "5 -> 8");
  });
});
