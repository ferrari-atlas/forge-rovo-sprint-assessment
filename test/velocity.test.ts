import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSprintReport,
  computeVelocitySignal,
  type SprintVelocityData,
} from "../src/velocity";
import type { SprintReportResponse } from "../src/jira/software/board";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHistory(
  overrides: Partial<SprintVelocityData> = {},
): SprintVelocityData {
  return {
    sprintId: 1,
    sprintName: "Sprint 1",
    completedIssues: 10,
    totalIssues: 12,
    completedPoints: 40,
    totalPoints: 50,
    ...overrides,
  };
}

function makeSprintReport(
  overrides: {
    completedCount?: number;
    notCompletedCount?: number;
    puntedCount?: number;
    completedEstimateSum?: { value?: number; text: string };
    allEstimateSum?: { value?: number; text: string };
    sprintId?: number;
    sprintName?: string;
  } = {},
): SprintReportResponse {
  const completedCount = overrides.completedCount ?? 5;
  const notCompletedCount = overrides.notCompletedCount ?? 3;
  const puntedCount = overrides.puntedCount ?? 0;

  const makeIssues = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      key: `TEST-${i + 1}`,
      summary: `Issue ${i + 1}`,
      typeName: "Story",
      statusName: "Done",
      done: true,
      currentEstimateStatistic: {
        statFieldId: "customfield_10031",
        statFieldValue: { value: 5 },
      },
      estimateStatistic: {
        statFieldId: "customfield_10031",
        statFieldValue: { value: 5 },
      },
    }));

  return {
    contents: {
      completedIssues: makeIssues(completedCount),
      issuesNotCompletedInCurrentSprint: makeIssues(notCompletedCount),
      puntedIssues: makeIssues(puntedCount),
      issuesCompletedInAnotherSprint: [],
      completedIssuesEstimateSum:
        overrides.completedEstimateSum ?? { value: 25, text: "25.0" },
      completedIssuesInitialEstimateSum: { value: 20, text: "20.0" },
      issuesNotCompletedEstimateSum: { value: 15, text: "15.0" },
      issuesNotCompletedInitialEstimateSum: { value: 15, text: "15.0" },
      allIssuesEstimateSum:
        overrides.allEstimateSum ?? { value: 40, text: "40.0" },
      puntedIssuesEstimateSum: { text: "null" },
      puntedIssuesInitialEstimateSum: { text: "null" },
      issuesCompletedInAnotherSprintEstimateSum: { text: "null" },
      issuesCompletedInAnotherSprintInitialEstimateSum: { text: "null" },
      issueKeysAddedDuringSprint: {},
    },
    sprint: {
      id: overrides.sprintId ?? 100,
      name: overrides.sprintName ?? "Test Sprint",
      state: "CLOSED",
    },
  };
}

// ---------------------------------------------------------------------------
// parseSprintReport
// ---------------------------------------------------------------------------

describe("parseSprintReport", () => {
  it("extracts counts and points from a sprint report", () => {
    const report = makeSprintReport({
      completedCount: 8,
      notCompletedCount: 2,
      puntedCount: 1,
      completedEstimateSum: { value: 30, text: "30.0" },
      allEstimateSum: { value: 45, text: "45.0" },
      sprintId: 42,
      sprintName: "Sprint 42",
    });
    const result = parseSprintReport(report);
    assert.equal(result.sprintId, 42);
    assert.equal(result.sprintName, "Sprint 42");
    assert.equal(result.completedIssues, 8);
    assert.equal(result.totalIssues, 11); // 8 + 2 + 1
    assert.equal(result.completedPoints, 30);
    assert.equal(result.totalPoints, 45);
  });

  it("returns null points when team does not use story points", () => {
    const report = makeSprintReport({
      completedEstimateSum: { text: "null" },
      allEstimateSum: { text: "null" },
    });
    const result = parseSprintReport(report);
    assert.equal(result.completedPoints, null);
    assert.equal(result.totalPoints, null);
  });

  it("handles zero completed points correctly (not null)", () => {
    const report = makeSprintReport({
      completedEstimateSum: { value: 0, text: "0.0" },
      allEstimateSum: { value: 10, text: "10.0" },
    });
    const result = parseSprintReport(report);
    assert.equal(result.completedPoints, 0);
    assert.equal(result.totalPoints, 10);
  });
});

// ---------------------------------------------------------------------------
// computeVelocitySignal
// ---------------------------------------------------------------------------

describe("computeVelocitySignal", () => {
  it("returns null when history is empty", () => {
    const result = computeVelocitySignal([], { totalIssues: 10, totalPoints: 40 });
    assert.equal(result, null);
  });

  it("computes within range signal correctly", () => {
    const history = [
      makeHistory({ completedIssues: 10, completedPoints: 40 }),
      makeHistory({ sprintId: 2, sprintName: "Sprint 2", completedIssues: 12, completedPoints: 45 }),
      makeHistory({ sprintId: 3, sprintName: "Sprint 3", completedIssues: 11, completedPoints: 42 }),
    ];
    const result = computeVelocitySignal(history, { totalIssues: 11, totalPoints: 43 });
    assert.ok(result);
  });

  it("computes positive percent diff for issues above average", () => {
    const history = [
      makeHistory({ completedIssues: 10 }),
      makeHistory({ sprintId: 2, completedIssues: 12 }),
      makeHistory({ sprintId: 3, completedIssues: 11 }),
    ];
    const result = computeVelocitySignal(history, { totalIssues: 20, totalPoints: null });
    assert.ok(result);
    assert.ok(result.issuePercentDiff > 0);
    assert.equal(result.pointsPercentDiff, null);
  });

  it("computes negative percent diff for issues below average", () => {
    const history = [
      makeHistory({ completedIssues: 10 }),
      makeHistory({ sprintId: 2, completedIssues: 12 }),
      makeHistory({ sprintId: 3, completedIssues: 11 }),
    ];
    const result = computeVelocitySignal(history, { totalIssues: 5, totalPoints: null });
    assert.ok(result);
    assert.ok(result.issuePercentDiff < 0);
  });

  it("computes positive percent diff for points above average", () => {
    const history = [
      makeHistory({ completedIssues: 10, completedPoints: 40 }),
      makeHistory({ sprintId: 2, completedIssues: 12, completedPoints: 45 }),
      makeHistory({ sprintId: 3, completedIssues: 11, completedPoints: 42 }),
    ];
    const result = computeVelocitySignal(history, { totalIssues: 11, totalPoints: 80 });
    assert.ok(result);
    assert.ok(result.pointsPercentDiff! > 0);
  });

  it("computes positive percent diff for both issues and points above average", () => {
    const history = [
      makeHistory({ completedIssues: 10, completedPoints: 40 }),
      makeHistory({ sprintId: 2, completedIssues: 12, completedPoints: 45 }),
      makeHistory({ sprintId: 3, completedIssues: 11, completedPoints: 42 }),
    ];
    const result = computeVelocitySignal(history, { totalIssues: 25, totalPoints: 80 });
    assert.ok(result);
    assert.ok(result.issuePercentDiff > 0);
    assert.ok(result.pointsPercentDiff! > 0);
  });

  it("works with only 1 historical sprint", () => {
    const history = [makeHistory({ completedIssues: 10, completedPoints: 40 })];
    const result = computeVelocitySignal(history, { totalIssues: 15, totalPoints: 60 });
    assert.ok(result);
    assert.equal(result.history.length, 1);
    assert.equal(result.averageCompletedIssues, 10);
    assert.equal(result.averageCompletedPoints, 40);
    assert.ok(result.issuePercentDiff > 0);
    assert.ok(result.pointsPercentDiff! > 0);
  });

  it("works with only 2 historical sprints", () => {
    const history = [
      makeHistory({ completedIssues: 10, completedPoints: 40 }),
      makeHistory({ sprintId: 2, completedIssues: 14, completedPoints: 50 }),
    ];
    const result = computeVelocitySignal(history, { totalIssues: 12, totalPoints: 45 });
    assert.ok(result);
    assert.equal(result.history.length, 2);
    assert.equal(result.averageCompletedIssues, 12);
    assert.equal(result.averageCompletedPoints, 45);
    assert.equal(result.issuePercentDiff, 0);
    assert.equal(result.pointsPercentDiff, 0);
  });

  it("handles null points in current sprint when history has points", () => {
    const history = [
      makeHistory({ completedIssues: 10, completedPoints: 40 }),
    ];
    const result = computeVelocitySignal(history, { totalIssues: 10, totalPoints: null });
    assert.ok(result);
    assert.equal(result.pointsPercentDiff, null);
    assert.equal(result.averageCompletedPoints, null);
  });

  it("handles null points in history when current has points", () => {
    const history = [
      makeHistory({ completedIssues: 10, completedPoints: null }),
    ];
    const result = computeVelocitySignal(history, { totalIssues: 10, totalPoints: 50 });
    assert.ok(result);
    // No historical points to compare against
    assert.equal(result.pointsPercentDiff, null);
  });

  it("computes percent diff correctly", () => {
    const history = [
      makeHistory({ completedIssues: 20, completedPoints: 100 }),
      makeHistory({ sprintId: 2, completedIssues: 20, completedPoints: 100 }),
      makeHistory({ sprintId: 3, completedIssues: 20, completedPoints: 100 }),
    ];
    // 50% more issues and points
    const result = computeVelocitySignal(history, { totalIssues: 30, totalPoints: 150 });
    assert.ok(result);
    assert.equal(result.issuePercentDiff, 50);
    assert.equal(result.pointsPercentDiff, 50);
  });

  it("computes negative percent diff correctly", () => {
    const history = [
      makeHistory({ completedIssues: 20, completedPoints: 100 }),
      makeHistory({ sprintId: 2, completedIssues: 20, completedPoints: 100 }),
      makeHistory({ sprintId: 3, completedIssues: 20, completedPoints: 100 }),
    ];
    // 50% fewer issues and points
    const result = computeVelocitySignal(history, { totalIssues: 10, totalPoints: 50 });
    assert.ok(result);
    assert.equal(result.issuePercentDiff, -50);
    assert.equal(result.pointsPercentDiff, -50);
  });
});
