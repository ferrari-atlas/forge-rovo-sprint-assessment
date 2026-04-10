import type { IssueAssessment } from "./signals";
import type { SprintSummary } from "./responses";
import type { VelocitySignal } from "./velocity";

// ---------------------------------------------------------------------------
// Config — default thresholds for all deterministic rules
// ---------------------------------------------------------------------------

/**
 * Assessment configuration with tuneable thresholds.
 *
 * Future: load overrides from a YAML file on a Confluence page.
 *
 * YAML format:
 * ```yaml
 * carryOver:
 *   highRiskSprintCount: 3
 * ownership:
 *   maxReassignments: 3
 *   maxIssuePercentPerAssignee: 40
 * estimates:
 *   maxRevisions: 3
 *   maxDriftPercent: 50
 * staleness:
 *   maxAgeDays: 30
 * ```
 */
export interface AssessmentConfig {
  carryOver: {
    highRiskSprintCount: number;
  };
  ownership: {
    maxReassignments: number;
    maxIssuePercentPerAssignee: number;
  };
  estimates: {
    maxRevisions: number;
    maxDriftPercent: number;
  };
  staleness: {
    maxAgeDays: number;
  };
  velocity: {
    maxOverCommitPercent: number;
  };
}

export const DEFAULT_CONFIG: AssessmentConfig = {
  carryOver: {
    highRiskSprintCount: 3,
  },
  ownership: {
    maxReassignments: 3,
    maxIssuePercentPerAssignee: 40,
  },
  estimates: {
    maxRevisions: 3,
    maxDriftPercent: 50,
  },
  staleness: {
    maxAgeDays: 30,
  },
  velocity: {
    maxOverCommitPercent: 25,
  },
};

// ---------------------------------------------------------------------------
// Rule Result
// ---------------------------------------------------------------------------

export interface RuleResult {
  id: string;
  name: string;
  category: string;
  passed: boolean;
  /** Issue keys that triggered the rule (empty if passed or sprint-level rule). */
  flaggedIssues: string[];
  /** Human-readable detail explaining the result. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Individual Rules
// ---------------------------------------------------------------------------

/**
 * Rule 0: Sprint has a meaningful name.
 * Fails if the sprint name matches the default pattern: "{PROJECT KEY} Sprint {integer}".
 */
export function ruleSprintHasName(sprint: SprintSummary): RuleResult {
  const defaultPattern = /\bSprint \d+$/i;
  const isDefault = defaultPattern.test(sprint.name.trim());
  return {
    id: "sprint-has-name",
    name: "Sprint has a meaningful name",
    category: "Sprint Hygiene",
    passed: !isDefault,
    flaggedIssues: [],
    detail: isDefault
      ? `Sprint name "${sprint.name}" appears to be a default name. A good sprint name is two words that capture the zeitgeist of the sprint.`
      : `Sprint has a custom name: "${sprint.name}".`,
  };
}

/**
 * Rule 1: Sprint has a goal.
 * Passes if sprint.goal is present and non-empty.
 */
export function ruleSprintHasGoal(sprint: SprintSummary): RuleResult {
  const hasGoal = !!sprint.goal && sprint.goal.trim() !== "";
  return {
    id: "sprint-has-goal",
    name: "Sprint has a goal",
    category: "Sprint Hygiene",
    passed: hasGoal,
    flaggedIssues: [],
    detail: hasGoal
      ? "Sprint has a defined goal."
      : "Sprint has no goal set. A sprint goal helps the team focus and provides context for prioritisation.",
  };
}

/**
 * Rule 2: All issues have an assignee.
 * Passes if zero issues are unassigned.
 */
export function ruleAllIssuesAssigned(issues: IssueAssessment[]): RuleResult {
  const unassigned = issues.filter((i) => i.assignee === "Unassigned");
  const passed = unassigned.length === 0;
  return {
    id: "all-issues-assigned",
    name: "All work items have an assignee",
    category: "Issue Readiness",
    passed,
    flaggedIssues: unassigned.map((i) => i.key),
    detail: passed
      ? "All work items have an assignee."
      : `${unassigned.length} work item(s) are unassigned.`,
  };
}

/**
 * Rule 3: All issues have an estimate.
 * Inferred from changelog — passes if all issues show evidence of estimation.
 */
export function ruleAllIssuesEstimated(issues: IssueAssessment[]): RuleResult {
  const unestimated = issues.filter((i) => !i.hasEstimate);
  const passed = unestimated.length === 0;
  return {
    id: "all-issues-estimated",
    name: "All work items have an estimate",
    category: "Issue Readiness",
    passed,
    flaggedIssues: unestimated.map((i) => i.key),
    detail: passed
      ? "All work items show evidence of estimation."
      : `${unestimated.length} work item(s) have no estimate detected in their change history.`,
  };
}

/**
 * Rule 4: No high-risk carry-overs.
 * Flags issues that have appeared in N or more sprints.
 */
export function ruleNoHighRiskCarryOvers(
  issues: IssueAssessment[],
  config: AssessmentConfig,
): RuleResult {
  const threshold = config.carryOver.highRiskSprintCount;
  const flagged = issues.filter((i) => i.sprintCount >= threshold);
  const passed = flagged.length === 0;
  return {
    id: "no-high-risk-carryovers",
    name: "No high-risk carry-overs",
    category: "Carry-Over Risk",
    passed,
    flaggedIssues: flagged.map((i) => i.key),
    detail: passed
      ? `No work items have been carried over across ${threshold} or more sprints.`
      : `${flagged.length} work item(s) have been carried over across ${threshold} or more sprints.`,
  };
}

/**
 * Rule 5: Issues have stable ownership.
 * Flags issues reassigned too many times.
 */
export function ruleStableOwnership(
  issues: IssueAssessment[],
  config: AssessmentConfig,
): RuleResult {
  const threshold = config.ownership.maxReassignments;
  const flagged = issues.filter((i) => i.assigneeChanges.count >= threshold);
  const passed = flagged.length === 0;
  return {
    id: "stable-ownership",
    name: "Work items have stable ownership",
    category: "Ownership Stability",
    passed,
    flaggedIssues: flagged.map((i) => i.key),
    detail: passed
      ? `No work items have been reassigned ${threshold} or more times.`
      : `${flagged.length} work item(s) have been reassigned ${threshold} or more times.`,
  };
}

/**
 * Rule 6: Work is distributed.
 * Fails if any single assignee owns more than X% of sprint items.
 */
export function ruleWorkDistributed(
  issues: IssueAssessment[],
  config: AssessmentConfig,
): RuleResult {
  const threshold = config.ownership.maxIssuePercentPerAssignee;
  const total = issues.length;

  if (total === 0) {
    return {
      id: "work-distributed",
      name: "Work is distributed",
      category: "Ownership Stability",
      passed: true,
      flaggedIssues: [],
      detail: "No work items to evaluate.",
    };
  }

  // Count issues per assignee
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const name = issue.assignee;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const overloaded: { assignee: string; percent: number }[] = [];
  for (const [assignee, count] of counts) {
    const percent = Math.round((count / total) * 100);
    if (percent > threshold) {
      overloaded.push({ assignee, percent });
    }
  }

  const passed = overloaded.length === 0;
  return {
    id: "work-distributed",
    name: "Work is distributed",
    category: "Ownership Stability",
    passed,
    flaggedIssues: [],
    detail: passed
      ? `No assignee owns more than ${threshold}% of sprint items.`
      : overloaded
          .map((o) => `${o.assignee} owns ${o.percent}% of sprint items (threshold: ${threshold}%)`)
          .join("; "),
  };
}

/**
 * Rule 7: Estimates are stable.
 * Flags issues with too many estimate revisions.
 */
export function ruleEstimatesStable(
  issues: IssueAssessment[],
  config: AssessmentConfig,
): RuleResult {
  const threshold = config.estimates.maxRevisions;
  const flagged = issues.filter(
    (i) => i.estimateChanges.totalChanges >= threshold,
  );
  const passed = flagged.length === 0;
  return {
    id: "estimates-stable",
    name: "Estimates are stable",
    category: "Estimate Stability",
    passed,
    flaggedIssues: flagged.map((i) => i.key),
    detail: passed
      ? `No issues have ${threshold} or more estimate revisions.`
      : `${flagged.length} issue(s) have ${threshold} or more estimate revisions.`,
  };
}

/**
 * Rule 8: No major estimate drift.
 * Flags issues where the latest estimate change exceeds the drift threshold.
 */
export function ruleNoMajorDrift(
  issues: IssueAssessment[],
  config: AssessmentConfig,
): RuleResult {
  const threshold = config.estimates.maxDriftPercent;
  const flagged: string[] = [];

  for (const issue of issues) {
    const pointsDrift = issue.estimateChanges.points.latestDrift;
    const timeDrift = issue.estimateChanges.time.latestDrift;

    const pointsExceeds =
      pointsDrift?.changePercent !== null &&
      pointsDrift?.changePercent !== undefined &&
      Math.abs(pointsDrift.changePercent) >= threshold;

    const timeExceeds =
      timeDrift?.changePercent !== null &&
      timeDrift?.changePercent !== undefined &&
      Math.abs(timeDrift.changePercent) >= threshold;

    if (pointsExceeds || timeExceeds) {
      flagged.push(issue.key);
    }
  }

  const passed = flagged.length === 0;
  return {
    id: "no-major-drift",
    name: "No major estimate drift",
    category: "Estimate Stability",
    passed,
    flaggedIssues: flagged,
    detail: passed
      ? `No work items have estimate drift exceeding ${threshold}%.`
      : `${flagged.length} work item(s) have estimate drift exceeding ${threshold}%.`,
  };
}

/**
 * Rule 9: No stale issues.
 * Flags incomplete issues older than the threshold.
 * "Incomplete" = statusCategory is not "Done".
 */
export function ruleNoStaleIssues(
  issues: IssueAssessment[],
  config: AssessmentConfig,
): RuleResult {
  const threshold = config.staleness.maxAgeDays;
  const flagged = issues.filter(
    (i) =>
      i.statusCategory !== "Done" &&
      i.sprintAge.ageDays !== null &&
      i.sprintAge.ageDays > threshold,
  );
  const passed = flagged.length === 0;
  return {
    id: "no-stale-issues",
    name: "No stale work items",
    category: "Staleness",
    passed,
    flaggedIssues: flagged.map((i) => i.key),
    detail: passed
      ? `No incomplete work items are older than ${threshold} days since first sprint assignment.`
      : `${flagged.length} incomplete issue(s) are older than ${threshold} days since first sprint assignment.`,
  };
}

// ---------------------------------------------------------------------------
// Rule 10: Commitment vs Velocity
// ---------------------------------------------------------------------------

/**
 * Rule 10: Commitment aligns with recent velocity.
 * Compares the current sprint's committed issue count (and points, if available)
 * against the completed averages from the last N closed sprints.
 */
export function ruleCommitmentVsVelocity(
  signal: VelocitySignal,
  config: AssessmentConfig,
): RuleResult {
  const threshold = config.velocity.maxOverCommitPercent;
  const parts: string[] = [];

  // Only positive overcommit triggers failure; under-commitment is not penalised.
  const issueOver = signal.issuePercentDiff > threshold;
  parts.push(
    `Current sprint: ${signal.current.totalIssues} work items committed. ` +
      `Recent ${signal.history.length} sprint avg: ${signal.averageCompletedIssues} work items completed. ` +
      `Difference: ${signal.issuePercentDiff > 0 ? "+" : ""}${signal.issuePercentDiff}% (threshold: +${threshold}%).`,
  );

  // Points-based detail (if available)
  let pointsOver = false;
  if (
    signal.current.totalPoints !== null &&
    signal.averageCompletedPoints !== null &&
    signal.pointsPercentDiff !== null
  ) {
    pointsOver = signal.pointsPercentDiff > threshold;
    parts.push(
      `Points: ${signal.current.totalPoints} committed vs ${signal.averageCompletedPoints} avg completed. ` +
        `Difference: ${signal.pointsPercentDiff > 0 ? "+" : ""}${signal.pointsPercentDiff}% (threshold: +${threshold}%).`,
    );
  }

  const passed = !issueOver && !pointsOver;

  return {
    id: "commitment-vs-velocity",
    name: "Commitment aligns with recent velocity",
    category: "Commitment Risk",
    passed,
    flaggedIssues: [],
    detail: parts.join(" "),
  };
}

// ---------------------------------------------------------------------------
// Evaluate All Rules
// ---------------------------------------------------------------------------

/**
 * Context object for rule evaluation.
 * Bundles all inputs so additional signals can be added without parameter sprawl.
 */
export interface RuleEvaluationContext {
  sprint: SprintSummary;
  issues: IssueAssessment[];
  config?: AssessmentConfig;
  velocitySignal?: VelocitySignal | null;
}

/**
 * Parses a YAML config string and deep-merges it with DEFAULT_CONFIG.
 * Only known keys are merged — unknown keys are silently ignored.
 * Returns DEFAULT_CONFIG if the input is empty or unparseable.
 */
export function parseConfigOverride(yaml: string | undefined): AssessmentConfig {
  if (!yaml || yaml.trim() === "") return { ...DEFAULT_CONFIG };

  try {
    const parsed = parseSimpleYaml(yaml);
    return {
      carryOver: {
        highRiskSprintCount:
          parsed.carryOver?.highRiskSprintCount ?? DEFAULT_CONFIG.carryOver.highRiskSprintCount,
      },
      ownership: {
        maxReassignments:
          parsed.ownership?.maxReassignments ?? DEFAULT_CONFIG.ownership.maxReassignments,
        maxIssuePercentPerAssignee:
          parsed.ownership?.maxIssuePercentPerAssignee ?? DEFAULT_CONFIG.ownership.maxIssuePercentPerAssignee,
      },
      estimates: {
        maxRevisions:
          parsed.estimates?.maxRevisions ?? DEFAULT_CONFIG.estimates.maxRevisions,
        maxDriftPercent:
          parsed.estimates?.maxDriftPercent ?? DEFAULT_CONFIG.estimates.maxDriftPercent,
      },
      staleness: {
        maxAgeDays:
          parsed.staleness?.maxAgeDays ?? DEFAULT_CONFIG.staleness.maxAgeDays,
      },
      velocity: {
        maxOverCommitPercent:
          parsed.velocity?.maxOverCommitPercent ?? DEFAULT_CONFIG.velocity.maxOverCommitPercent,
      },
    };
  } catch {
    console.warn("Failed to parse config override, using defaults");
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Minimal YAML parser for our flat two-level config structure.
 * Handles the format:
 *   topKey:
 *     nestedKey: numericValue
 *
 * No dependency on a YAML library.
 */
function parseSimpleYaml(yaml: string): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  let currentSection = "";

  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    // Top-level key (no leading whitespace, ends with colon)
    const topMatch = line.match(/^([a-zA-Z]+):$/);
    if (topMatch) {
      currentSection = topMatch[1]!;
      result[currentSection] = {};
      continue;
    }

    // Nested key: value (leading whitespace)
    const nestedMatch = line.match(/^\s+([a-zA-Z]+):\s*(.+)$/);
    if (nestedMatch && currentSection) {
      const key = nestedMatch[1]!;
      const value = Number(nestedMatch[2]!.trim());
      if (!Number.isNaN(value) && result[currentSection]) {
        result[currentSection]![key] = value;
      }
    }
  }

  return result;
}

/**
 * Runs all deterministic rules against the sprint and its issues.
 * Returns an array of RuleResult objects — one per rule.
 *
 * The velocity rule is only included when a VelocitySignal is provided
 * (requires closed sprint history to be available).
 */
export function evaluateAllRules(ctx: RuleEvaluationContext): RuleResult[] {
  const { sprint, issues, config = DEFAULT_CONFIG, velocitySignal } = ctx;

  const results: RuleResult[] = [
    ruleSprintHasName(sprint),
    ruleSprintHasGoal(sprint),
    ruleAllIssuesAssigned(issues),
    ruleAllIssuesEstimated(issues),
    ruleNoHighRiskCarryOvers(issues, config),
    ruleStableOwnership(issues, config),
    ruleWorkDistributed(issues, config),
    ruleEstimatesStable(issues, config),
    ruleNoMajorDrift(issues, config),
    ruleNoStaleIssues(issues, config),
  ];

  if (velocitySignal) {
    results.push(ruleCommitmentVsVelocity(velocitySignal, config));
  }

  return results;
}
