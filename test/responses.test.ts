import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAssessmentResponse } from "../src/assessSprint";
import {
  makeErrorResponse,
  toBoardSummary,
  toSprintSummary,
  toBacklogIssueSummary,
  toSprintIssueSummary,
} from "../src/responses";
import type { IssueAssessment } from "../src/signals";
import type { SearchIssue } from "../src/jira/search";

// ---------------------------------------------------------------------------
// buildAssessmentResponse
// ---------------------------------------------------------------------------

describe("buildAssessmentResponse", () => {
  const sprint = {
    id: 42,
    self: "https://example.atlassian.net/rest/agile/1.0/sprint/42",
    state: "active",
    name: "Sprint 42",
    startDate: "2026-04-01",
    endDate: "2026-04-15",
    goal: "Ship the thing",
  };

  // Shared defaults for the new signal fields
  const noAssigneeChanges = { count: 0, changes: [] };
  const noEstimateChanges = { points: { count: 0, changes: [], latestDrift: null }, time: { count: 0, changes: [], latestDrift: null }, totalChanges: 0 };
  const noSprintAge = { firstSprintDate: null, ageDays: null };

  const assessments: IssueAssessment[] = [
    {
      key: "PROJ-1",
      summary: "High risk issue",
      type: "Story",
      status: "In Progress",
      statusCategory: "In Progress",
      assignee: "Alice",
      priority: "High",
      hasEstimate: true,
      sprintCount: 4,
      sprintNames: ["Sprint 39", "Sprint 40", "Sprint 41", "Sprint 42"],
      risk: "High",
      assigneeChanges: { count: 2, changes: [
        { from: null, to: "Alice", date: "2026-03-01T10:00:00.000+0000" },
        { from: "Alice", to: "Bob", date: "2026-03-10T10:00:00.000+0000" },
      ]},
      estimateChanges: { points: { count: 1, changes: [
        { field: "Story Points", from: "3", to: "5", date: "2026-03-05T10:00:00.000+0000" },
      ], latestDrift: { from: "3", to: "5", display: "3 -> 5", changePercent: 67 } }, time: { count: 0, changes: [], latestDrift: null }, totalChanges: 1 },
      sprintAge: { firstSprintDate: "2026-03-01T10:00:00.000+0000", ageDays: 38 },
    },
    {
      key: "PROJ-2",
      summary: "Medium risk issue",
      type: "Task",
      status: "To Do",
      statusCategory: "To Do",
      assignee: "Bob",
      priority: "Medium",
      hasEstimate: true,
      sprintCount: 2,
      sprintNames: ["Sprint 41", "Sprint 42"],
      risk: "Medium",
      assigneeChanges: noAssigneeChanges,
      estimateChanges: noEstimateChanges,
      sprintAge: { firstSprintDate: "2026-03-20T10:00:00.000+0000", ageDays: 19 },
    },
    {
      key: "PROJ-3",
      summary: "Low risk issue",
      type: "Bug",
      status: "Done",
      statusCategory: "Done",
      assignee: "Charlie",
      priority: "Low",
      hasEstimate: false,
      sprintCount: 1,
      sprintNames: ["Sprint 42"],
      risk: "Low",
      assigneeChanges: noAssigneeChanges,
      estimateChanges: noEstimateChanges,
      sprintAge: noSprintAge,
    },
  ];

  it("returns ok:true with correct action name", () => {
    const result = buildAssessmentResponse(sprint, assessments, false, 3);
    assert.equal(result.ok, true);
    assert.equal(result.action, "assess-sprint");
  });

  it("includes sprint metadata in data.sprint", () => {
    const result = buildAssessmentResponse(sprint, assessments, false, 3);
    assert.equal(result.data.sprint.id, 42);
    assert.equal(result.data.sprint.name, "Sprint 42");
    assert.equal(result.data.sprint.goal, "Ship the thing");
  });

  it("computes correct risk counts", () => {
    const result = buildAssessmentResponse(sprint, assessments, false, 3);
    assert.deepEqual(result.data.summary.riskCounts, {
      high: 1,
      medium: 1,
      low: 1,
    });
  });

  it("reports capped=false when under limit", () => {
    const result = buildAssessmentResponse(sprint, assessments, false, 3);
    assert.equal(result.data.summary.capped, false);
    assert.equal(result.data.summary.assessedIssueCount, 3);
    assert.equal(result.data.summary.totalIssueCount, 3);
  });

  it("reports capped=true with correct total when over limit", () => {
    const result = buildAssessmentResponse(sprint, assessments, true, 150);
    assert.equal(result.data.summary.capped, true);
    assert.equal(result.data.summary.assessedIssueCount, 3);
    assert.equal(result.data.summary.totalIssueCount, 150);
  });

  it("preserves all issue assessments in data.issues", () => {
    const result = buildAssessmentResponse(sprint, assessments, false, 3);
    assert.equal(result.data.issues.length, 3);
    assert.equal(result.data.issues[0]!.key, "PROJ-1");
    assert.equal(result.data.issues[0]!.risk, "High");
    assert.equal(result.data.issues[2]!.key, "PROJ-3");
    assert.equal(result.data.issues[2]!.risk, "Low");
  });
});

// ---------------------------------------------------------------------------
// makeErrorResponse
// ---------------------------------------------------------------------------

describe("makeErrorResponse", () => {
  it("returns ok:false with correct structure", () => {
    const result = makeErrorResponse(
      "assess-sprint",
      "NO_SPRINTS",
      "No active sprint found",
    );
    assert.equal(result.ok, false);
    assert.equal(result.action, "assess-sprint");
    assert.equal(result.error.code, "NO_SPRINTS");
    assert.equal(result.error.message, "No active sprint found");
  });
});

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

describe("toSprintSummary", () => {
  it("maps SprintResponse fields correctly", () => {
    const sprint = {
      id: 10,
      self: "https://example.com/sprint/10",
      state: "active",
      name: "Sprint 10",
      startDate: "2026-01-01",
      endDate: "2026-01-15",
      goal: "Goal",
    };
    const result = toSprintSummary(sprint);
    assert.equal(result.id, 10);
    assert.equal(result.name, "Sprint 10");
    assert.equal(result.state, "active");
    assert.equal(result.goal, "Goal");
    // self is intentionally excluded from the summary
    assert.equal("self" in result, false);
  });
});

describe("toBoardSummary", () => {
  it("maps BoardResponse fields correctly", () => {
    const board = {
      id: 5,
      name: "My Board",
      self: "https://example.com/board/5",
      type: "scrum",
      location: {
        projectId: 100,
        projectName: "My Project",
        projectKey: "MP",
        projectTypeKey: "software",
        displayName: "My Board",
        name: "My Board",
        userAccountId: "",
        userId: 0,
      },
    };
    const result = toBoardSummary(board);
    assert.equal(result.id, 5);
    assert.equal(result.name, "My Board");
    assert.equal(result.type, "scrum");
    assert.equal(result.projectKey, "MP");
    assert.equal(result.projectName, "My Project");
  });
});

describe("toBacklogIssueSummary", () => {
  it("maps fields and defaults unassigned", () => {
    const issue = {
      id: "1001",
      key: "MP-10",
      fields: {
        summary: "Backlog item",
        status: { name: "To Do" },
        issuetype: { name: "Story" },
      },
    };
    const result = toBacklogIssueSummary(issue);
    assert.equal(result.key, "MP-10");
    assert.equal(result.assignee, "Unassigned");
    assert.equal(result.priority, "-");
  });
});

describe("toSprintIssueSummary", () => {
  it("maps issue with changelog entries", () => {
    const issue: SearchIssue = {
      id: "2001",
      key: "MP-20",
      self: "https://example.com/issue/2001",
      fields: {
        summary: "Sprint issue",
        status: { name: "In Progress", statusCategory: { name: "In Progress" } },
        issuetype: { name: "Task" },
        assignee: { displayName: "Dev" },
        priority: { name: "High" },
      },
      changelog: {
        startAt: 0,
        maxResults: 50,
        total: 1,
        histories: [
          {
            id: "100",
            author: { accountId: "abc", displayName: "Dev" },
            created: "2026-04-02T10:00:00.000+0000",
            items: [
              {
                field: "status",
                fieldtype: "jira",
                from: "10000",
                fromString: "To Do",
                to: "10001",
                toString: "In Progress",
              },
            ],
          },
        ],
      },
    };
    const result = toSprintIssueSummary(issue);
    assert.equal(result.key, "MP-20");
    assert.equal(result.assignee, "Dev");
    assert.equal(result.changelogTotal, 1);
    assert.equal(result.changelogReturned, 1);
    assert.equal(result.changelog.length, 1);
    assert.equal(result.changelog[0]!.author, "Dev");
    assert.equal(result.changelog[0]!.items[0]!.field, "status");
    assert.equal(result.changelog[0]!.items[0]!.from, "To Do");
    assert.equal(result.changelog[0]!.items[0]!.to, "In Progress");
  });
});
