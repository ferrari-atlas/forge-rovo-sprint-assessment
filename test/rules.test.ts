import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ruleSprintHasName,
  ruleSprintHasGoal,
  ruleAllIssuesAssigned,
  ruleAllIssuesEstimated,
  ruleNoHighRiskCarryOvers,
  ruleStableOwnership,
  ruleWorkDistributed,
  ruleEstimatesStable,
  ruleNoMajorDrift,
  ruleNoStaleIssues,
  ruleCommitmentVsVelocity,
  evaluateAllRules,
  parseConfigOverride,
  DEFAULT_CONFIG,
} from "../src/rules";
import type { IssueAssessment } from "../src/signals";
import type { SprintSummary } from "../src/responses";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noAssigneeChanges = { count: 0, changes: [] };
const noEstimateChanges = {
  points: { count: 0, changes: [], latestDrift: null },
  time: { count: 0, changes: [], latestDrift: null },
  totalChanges: 0,
};
const noSprintAge = { firstSprintDate: null, ageDays: null };

function makeAssessment(overrides: Partial<IssueAssessment> = {}): IssueAssessment {
  return {
    key: "TEST-1",
    summary: "Test issue",
    type: "Story",
    status: "To Do",
    statusCategory: "To Do",
    assignee: "Alice",
    priority: "Medium",
    hasEstimate: true,
    sprintCount: 1,
    sprintNames: ["Sprint 1"],
    risk: "Low",
    assigneeChanges: noAssigneeChanges,
    estimateChanges: noEstimateChanges,
    sprintAge: noSprintAge,
    ...overrides,
  };
}

const sprintWithGoal: SprintSummary = {
  id: 1,
  name: "Rocket Launch",
  state: "active",
  startDate: "2026-04-01",
  endDate: "2026-04-15",
  goal: "Ship the feature",
};

const sprintWithoutGoal: SprintSummary = {
  id: 2,
  name: "Quiet Storm",
  state: "active",
};

// ---------------------------------------------------------------------------
// Rule 0: Sprint has a meaningful name
// ---------------------------------------------------------------------------

describe("ruleSprintHasName", () => {
  it("fails when sprint name matches default pattern", () => {
    const sprint = { ...sprintWithGoal, name: "MOBL Sprint 3" };
    const result = ruleSprintHasName(sprint);
    assert.equal(result.passed, false);
    assert.equal(result.id, "sprint-has-name");
  });

  it("fails for various default patterns", () => {
    for (const name of ["PROJ Sprint 1", "ABC Sprint 42", "MY_PROJ Sprint 100"]) {
      const result = ruleSprintHasName({ ...sprintWithGoal, name });
      assert.equal(result.passed, false, `Expected "${name}" to fail`);
    }
  });

  it("passes when sprint has a custom name", () => {
    const sprint = { ...sprintWithGoal, name: "Rocket Launch" };
    const result = ruleSprintHasName(sprint);
    assert.equal(result.passed, true);
  });

  it("passes for names that don't match the default pattern", () => {
    for (const name of ["Sprint Planning", "Q2 Release", "Payment Integration"]) {
      const result = ruleSprintHasName({ ...sprintWithGoal, name });
      assert.equal(result.passed, true, `Expected "${name}" to pass`);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 1: Sprint has a goal
// ---------------------------------------------------------------------------

describe("ruleSprintHasGoal", () => {
  it("passes when sprint has a goal", () => {
    const result = ruleSprintHasGoal(sprintWithGoal);
    assert.equal(result.passed, true);
    assert.equal(result.id, "sprint-has-goal");
  });

  it("fails when sprint has no goal", () => {
    const result = ruleSprintHasGoal(sprintWithoutGoal);
    assert.equal(result.passed, false);
  });

  it("fails when sprint goal is empty string", () => {
    const result = ruleSprintHasGoal({ ...sprintWithGoal, goal: "  " });
    assert.equal(result.passed, false);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: All issues have an assignee
// ---------------------------------------------------------------------------

describe("ruleAllIssuesAssigned", () => {
  it("passes when all issues are assigned", () => {
    const issues = [makeAssessment(), makeAssessment({ key: "TEST-2" })];
    const result = ruleAllIssuesAssigned(issues);
    assert.equal(result.passed, true);
  });

  it("fails with unassigned issues and flags them", () => {
    const issues = [
      makeAssessment(),
      makeAssessment({ key: "TEST-2", assignee: "Unassigned" }),
      makeAssessment({ key: "TEST-3", assignee: "Unassigned" }),
    ];
    const result = ruleAllIssuesAssigned(issues);
    assert.equal(result.passed, false);
    assert.deepEqual(result.flaggedIssues, ["TEST-2", "TEST-3"]);
  });

  it("passes with empty issue list", () => {
    const result = ruleAllIssuesAssigned([]);
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: All issues have an estimate
// ---------------------------------------------------------------------------

describe("ruleAllIssuesEstimated", () => {
  it("passes when all issues have estimates", () => {
    const issues = [makeAssessment(), makeAssessment({ key: "TEST-2" })];
    const result = ruleAllIssuesEstimated(issues);
    assert.equal(result.passed, true);
  });

  it("fails with unestimated issues and flags them", () => {
    const issues = [
      makeAssessment(),
      makeAssessment({ key: "TEST-2", hasEstimate: false }),
    ];
    const result = ruleAllIssuesEstimated(issues);
    assert.equal(result.passed, false);
    assert.deepEqual(result.flaggedIssues, ["TEST-2"]);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: No high-risk carry-overs
// ---------------------------------------------------------------------------

describe("ruleNoHighRiskCarryOvers", () => {
  it("passes when no issues exceed threshold", () => {
    const issues = [
      makeAssessment({ sprintCount: 1 }),
      makeAssessment({ key: "TEST-2", sprintCount: 2 }),
    ];
    const result = ruleNoHighRiskCarryOvers(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("fails when issues meet or exceed threshold", () => {
    const issues = [
      makeAssessment({ sprintCount: 3 }),
      makeAssessment({ key: "TEST-2", sprintCount: 5 }),
    ];
    const result = ruleNoHighRiskCarryOvers(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, false);
    assert.deepEqual(result.flaggedIssues, ["TEST-1", "TEST-2"]);
  });

  it("respects custom threshold", () => {
    const config = { ...DEFAULT_CONFIG, carryOver: { highRiskSprintCount: 5 } };
    const issues = [makeAssessment({ sprintCount: 3 })];
    const result = ruleNoHighRiskCarryOvers(issues, config);
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Stable ownership
// ---------------------------------------------------------------------------

describe("ruleStableOwnership", () => {
  it("passes when no issues have excessive reassignments", () => {
    const issues = [
      makeAssessment({ assigneeChanges: { count: 1, changes: [] } }),
    ];
    const result = ruleStableOwnership(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("fails when issues have too many reassignments", () => {
    const issues = [
      makeAssessment({ assigneeChanges: { count: 4, changes: [] } }),
    ];
    const result = ruleStableOwnership(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, false);
    assert.deepEqual(result.flaggedIssues, ["TEST-1"]);
  });
});

// ---------------------------------------------------------------------------
// Rule 6: Work is distributed
// ---------------------------------------------------------------------------

describe("ruleWorkDistributed", () => {
  it("passes when work is evenly distributed", () => {
    const issues = [
      makeAssessment({ assignee: "Alice" }),
      makeAssessment({ key: "TEST-2", assignee: "Bob" }),
      makeAssessment({ key: "TEST-3", assignee: "Charlie" }),
    ];
    const result = ruleWorkDistributed(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("fails when one person owns too much", () => {
    const issues = [
      makeAssessment({ assignee: "Alice" }),
      makeAssessment({ key: "TEST-2", assignee: "Alice" }),
      makeAssessment({ key: "TEST-3", assignee: "Alice" }),
      makeAssessment({ key: "TEST-4", assignee: "Bob" }),
    ];
    // Alice owns 75% > 40% threshold
    const result = ruleWorkDistributed(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, false);
  });

  it("passes with empty issue list", () => {
    const result = ruleWorkDistributed([], DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("respects custom threshold", () => {
    const config = {
      ...DEFAULT_CONFIG,
      ownership: { ...DEFAULT_CONFIG.ownership, maxIssuePercentPerAssignee: 80 },
    };
    const issues = [
      makeAssessment({ assignee: "Alice" }),
      makeAssessment({ key: "TEST-2", assignee: "Alice" }),
      makeAssessment({ key: "TEST-3", assignee: "Alice" }),
      makeAssessment({ key: "TEST-4", assignee: "Bob" }),
    ];
    const result = ruleWorkDistributed(issues, config);
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// Rule 7: Estimates are stable
// ---------------------------------------------------------------------------

describe("ruleEstimatesStable", () => {
  it("passes when estimate changes are below threshold", () => {
    const issues = [
      makeAssessment({
        estimateChanges: { ...noEstimateChanges, totalChanges: 2 },
      }),
    ];
    const result = ruleEstimatesStable(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("fails when estimate changes meet threshold", () => {
    const issues = [
      makeAssessment({
        estimateChanges: { ...noEstimateChanges, totalChanges: 3 },
      }),
    ];
    const result = ruleEstimatesStable(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, false);
    assert.deepEqual(result.flaggedIssues, ["TEST-1"]);
  });
});

// ---------------------------------------------------------------------------
// Rule 8: No major estimate drift
// ---------------------------------------------------------------------------

describe("ruleNoMajorDrift", () => {
  it("passes when no drift exceeds threshold", () => {
    const issues = [
      makeAssessment({
        estimateChanges: {
          points: {
            count: 1,
            changes: [],
            latestDrift: { from: "3", to: "4", display: "3 -> 4", changePercent: 33 },
          },
          time: { count: 0, changes: [], latestDrift: null },
          totalChanges: 1,
        },
      }),
    ];
    const result = ruleNoMajorDrift(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("fails when points drift exceeds threshold", () => {
    const issues = [
      makeAssessment({
        estimateChanges: {
          points: {
            count: 1,
            changes: [],
            latestDrift: { from: "3", to: "8", display: "3 -> 8", changePercent: 167 },
          },
          time: { count: 0, changes: [], latestDrift: null },
          totalChanges: 1,
        },
      }),
    ];
    const result = ruleNoMajorDrift(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, false);
    assert.deepEqual(result.flaggedIssues, ["TEST-1"]);
  });

  it("fails when time drift exceeds threshold", () => {
    const issues = [
      makeAssessment({
        estimateChanges: {
          points: { count: 0, changes: [], latestDrift: null },
          time: {
            count: 1,
            changes: [],
            latestDrift: { from: "1h", to: "4h", display: "1h -> 4h", changePercent: 300 },
          },
          totalChanges: 1,
        },
      }),
    ];
    const result = ruleNoMajorDrift(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, false);
  });

  it("passes when drift has null changePercent", () => {
    const issues = [
      makeAssessment({
        estimateChanges: {
          points: {
            count: 1,
            changes: [],
            latestDrift: { from: "abc", to: "xyz", display: "abc -> xyz", changePercent: null },
          },
          time: { count: 0, changes: [], latestDrift: null },
          totalChanges: 1,
        },
      }),
    ];
    const result = ruleNoMajorDrift(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("flags negative drift (decrease) exceeding threshold", () => {
    const issues = [
      makeAssessment({
        estimateChanges: {
          points: {
            count: 1,
            changes: [],
            latestDrift: { from: "8", to: "2", display: "8 -> 2", changePercent: -75 },
          },
          time: { count: 0, changes: [], latestDrift: null },
          totalChanges: 1,
        },
      }),
    ];
    const result = ruleNoMajorDrift(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, false);
  });
});

// ---------------------------------------------------------------------------
// Rule 9: No stale issues
// ---------------------------------------------------------------------------

describe("ruleNoStaleIssues", () => {
  it("passes when no incomplete issues exceed age threshold", () => {
    const issues = [
      makeAssessment({ sprintAge: { firstSprintDate: "2026-04-01", ageDays: 7 } }),
    ];
    const result = ruleNoStaleIssues(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("fails when incomplete issues exceed age threshold", () => {
    const issues = [
      makeAssessment({
        statusCategory: "To Do",
        sprintAge: { firstSprintDate: "2026-02-01", ageDays: 66 },
      }),
    ];
    const result = ruleNoStaleIssues(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, false);
    assert.deepEqual(result.flaggedIssues, ["TEST-1"]);
  });

  it("passes when old issues are Done", () => {
    const issues = [
      makeAssessment({
        statusCategory: "Done",
        sprintAge: { firstSprintDate: "2025-01-01", ageDays: 460 },
      }),
    ];
    const result = ruleNoStaleIssues(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("passes when ageDays is null", () => {
    const issues = [makeAssessment()];
    const result = ruleNoStaleIssues(issues, DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// ruleCommitmentVsVelocity
// ---------------------------------------------------------------------------

describe("ruleCommitmentVsVelocity", () => {
  function makeSignal(issuePercentDiff: number, pointsPercentDiff: number | null) {
    return {
      history: [{ sprintId: 1, sprintName: "S1", completedIssues: 10, totalIssues: 12, completedPoints: 40, totalPoints: 50 }],
      current: { totalIssues: 12, totalPoints: pointsPercentDiff !== null ? 50 : null },
      averageCompletedIssues: 10,
      averageCompletedPoints: pointsPercentDiff !== null ? 40 : null,
      issuePercentDiff,
      pointsPercentDiff,
    };
  }

  it("passes when both diffs are within threshold", () => {
    const result = ruleCommitmentVsVelocity(makeSignal(20, 20), DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("passes when diffs equal the threshold", () => {
    const result = ruleCommitmentVsVelocity(makeSignal(25, 25), DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("fails when issue diff exceeds threshold", () => {
    const result = ruleCommitmentVsVelocity(makeSignal(26, 10), DEFAULT_CONFIG);
    assert.equal(result.passed, false);
  });

  it("fails when points diff exceeds threshold", () => {
    const result = ruleCommitmentVsVelocity(makeSignal(10, 30), DEFAULT_CONFIG);
    assert.equal(result.passed, false);
  });

  it("passes when below threshold regardless of range verdict", () => {
    const result = ruleCommitmentVsVelocity(makeSignal(-10, -5), DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("passes when no points data available and issues within threshold", () => {
    const result = ruleCommitmentVsVelocity(makeSignal(20, null), DEFAULT_CONFIG);
    assert.equal(result.passed, true);
  });

  it("respects custom maxOverCommitPercent", () => {
    const config = { ...DEFAULT_CONFIG, velocity: { maxOverCommitPercent: 10 } };
    const passing = ruleCommitmentVsVelocity(makeSignal(10, 5), config);
    assert.equal(passing.passed, true);
    const failing = ruleCommitmentVsVelocity(makeSignal(11, 5), config);
    assert.equal(failing.passed, false);
  });

  it("includes threshold in detail string", () => {
    const result = ruleCommitmentVsVelocity(makeSignal(30, null), DEFAULT_CONFIG);
    assert.ok(result.detail.includes("threshold: +25%"));
  });
});

// ---------------------------------------------------------------------------
// evaluateAllRules
// ---------------------------------------------------------------------------

describe("evaluateAllRules", () => {
  it("returns exactly 10 rule results without velocity signal", () => {
    const issues = [makeAssessment()];
    const results = evaluateAllRules({ sprint: sprintWithGoal, issues });
    assert.equal(results.length, 10);
  });

  it("returns 11 rule results with velocity signal — failing", () => {
    const issues = [makeAssessment()];
    const velocitySignal = {
      history: [{ sprintId: 1, sprintName: "S1", completedIssues: 10, totalIssues: 12, completedPoints: 40, totalPoints: 50 }],
      current: { totalIssues: 14, totalPoints: 60 },
      averageCompletedIssues: 10,
      averageCompletedPoints: 40,
      issuePercentDiff: 40,
      pointsPercentDiff: 50,
    };
    const results = evaluateAllRules({ sprint: sprintWithGoal, issues, velocitySignal });
    assert.equal(results.length, 11);
    const velocityRule = results.find((r) => r.id === "commitment-vs-velocity");
    assert.ok(velocityRule);
    // 40% and 50% both exceed the default threshold of 25%
    assert.equal(velocityRule.passed, false);
  });

  it("returns 11 rule results with velocity signal — passing", () => {
    const issues = [makeAssessment()];
    const velocitySignal = {
      history: [{ sprintId: 1, sprintName: "S1", completedIssues: 10, totalIssues: 12, completedPoints: 40, totalPoints: 50 }],
      current: { totalIssues: 11, totalPoints: 45 },
      averageCompletedIssues: 10,
      averageCompletedPoints: 40,
      issuePercentDiff: 10,
      pointsPercentDiff: 12,
    };
    const results = evaluateAllRules({ sprint: sprintWithGoal, issues, velocitySignal });
    assert.equal(results.length, 11);
    const velocityRule = results.find((r) => r.id === "commitment-vs-velocity");
    assert.ok(velocityRule);
    // 10% and 12% are both within the default threshold of 25%
    assert.equal(velocityRule.passed, true);
  });

  it("all pass for a healthy sprint", () => {
    const issues = [
      makeAssessment({ assignee: "Alice" }),
      makeAssessment({ key: "TEST-2", assignee: "Bob" }),
      makeAssessment({ key: "TEST-3", assignee: "Charlie" }),
    ];
    const results = evaluateAllRules({ sprint: sprintWithGoal, issues });
    const allPassed = results.every((r) => r.passed);
    assert.equal(allPassed, true);
  });

  it("reports failures for an unhealthy sprint", () => {
    const issues = [
      makeAssessment({
        assignee: "Unassigned",
        hasEstimate: false,
        sprintCount: 5,
        statusCategory: "In Progress",
        sprintAge: { firstSprintDate: "2025-01-01", ageDays: 460 },
      }),
    ];
    const results = evaluateAllRules({ sprint: sprintWithoutGoal, issues });
    const failed = results.filter((r) => !r.passed);
    // Should fail: sprint-has-goal, all-issues-assigned, all-issues-estimated,
    // no-high-risk-carryovers, no-stale-issues
    assert.equal(failed.length >= 5, true);
  });
});

// ---------------------------------------------------------------------------
// parseConfigOverride
// ---------------------------------------------------------------------------

describe("parseConfigOverride", () => {
  it("returns defaults for undefined input", () => {
    const config = parseConfigOverride(undefined);
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  it("returns defaults for empty string", () => {
    const config = parseConfigOverride("");
    assert.deepEqual(config, DEFAULT_CONFIG);
  });

  it("returns defaults for unparseable input", () => {
    const config = parseConfigOverride("not: valid: yaml: at: all");
    // Should not throw, returns defaults
    assert.equal(config.carryOver.highRiskSprintCount, DEFAULT_CONFIG.carryOver.highRiskSprintCount);
  });

  it("overrides a single value", () => {
    const yaml = `carryOver:\n  highRiskSprintCount: 5`;
    const config = parseConfigOverride(yaml);
    assert.equal(config.carryOver.highRiskSprintCount, 5);
    // Other values unchanged
    assert.equal(config.ownership.maxReassignments, DEFAULT_CONFIG.ownership.maxReassignments);
    assert.equal(config.staleness.maxAgeDays, DEFAULT_CONFIG.staleness.maxAgeDays);
  });

  it("overrides multiple sections", () => {
    const yaml = [
      "carryOver:",
      "  highRiskSprintCount: 4",
      "ownership:",
      "  maxReassignments: 5",
      "  maxIssuePercentPerAssignee: 60",
      "estimates:",
      "  maxRevisions: 2",
      "  maxDriftPercent: 75",
      "staleness:",
      "  maxAgeDays: 14",
    ].join("\n");
    const config = parseConfigOverride(yaml);
    assert.equal(config.carryOver.highRiskSprintCount, 4);
    assert.equal(config.ownership.maxReassignments, 5);
    assert.equal(config.ownership.maxIssuePercentPerAssignee, 60);
    assert.equal(config.estimates.maxRevisions, 2);
    assert.equal(config.estimates.maxDriftPercent, 75);
    assert.equal(config.staleness.maxAgeDays, 14);
  });

  it("ignores unknown keys and preserves defaults", () => {
    const yaml = [
      "carryOver:",
      "  highRiskSprintCount: 10",
      "unknownSection:",
      "  someKey: 99",
    ].join("\n");
    const config = parseConfigOverride(yaml);
    assert.equal(config.carryOver.highRiskSprintCount, 10);
    assert.equal(config.ownership.maxReassignments, DEFAULT_CONFIG.ownership.maxReassignments);
  });

  it("handles partial section overrides", () => {
    const yaml = [
      "ownership:",
      "  maxReassignments: 7",
    ].join("\n");
    const config = parseConfigOverride(yaml);
    assert.equal(config.ownership.maxReassignments, 7);
    // maxIssuePercentPerAssignee not specified, should be default
    assert.equal(config.ownership.maxIssuePercentPerAssignee, DEFAULT_CONFIG.ownership.maxIssuePercentPerAssignee);
  });

  it("handles comments and blank lines", () => {
    const yaml = [
      "# Custom config",
      "",
      "staleness:",
      "  # Increase the threshold",
      "  maxAgeDays: 60",
    ].join("\n");
    const config = parseConfigOverride(yaml);
    assert.equal(config.staleness.maxAgeDays, 60);
  });

  it("overrides velocity.maxOverCommitPercent", () => {
    const yaml = `velocity:\n  maxOverCommitPercent: 50`;
    const config = parseConfigOverride(yaml);
    assert.equal(config.velocity.maxOverCommitPercent, 50);
    // Other values unchanged
    assert.equal(config.staleness.maxAgeDays, DEFAULT_CONFIG.staleness.maxAgeDays);
  });
});
