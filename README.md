# Forge Rovo Sprint Assessment

A Forge app providing a Rovo agent with actions for analysing active or planned Jira Software sprints. The agent retrieves board context, sprint work item data, and produces a structured risk assessments against a set of rules that represent best practices.

## Architecture

```
    User (Rovo Chat)
      |
      |-> Prompt: "Assess the active sprint", "Assess the next sprint for readiness"
      |
      v
    Sprint Assessment Agent
      |
      |-> Action: get-board-context
      |     Jira Software API: GET /rest/agile/1.0/board/{boardId}
      |     Jira Software API: GET /rest/agile/1.0/board/{boardId}/sprint?state=active|future
      |     Jira Software API: GET /rest/agile/1.0/board/{boardId}/backlog
      |
      |-> Action: get-sprint-issues
      |     Jira Software API: GET /rest/agile/1.0/board/{boardId}/sprint?state=active|future
      |     Jira REST API:     GET /rest/api/3/search/jql?jql=sprint={sprintId}&expand=changelog
      |
      |-> Action: assess-sprint
      |     Jira Software API: GET /rest/agile/1.0/board/{boardId}/sprint?state=active|future|closed
      |     Jira REST API:     GET /rest/api/3/search/jql?jql=sprint={sprintId}&expand=changelog
      |     Jira Software API: GET /rest/agile/1.0/rapid/charts/sprintreport?rapidViewId={boardId}&sprintId={sprintId}
      |
      +-> Action: explain-drift
            Jira REST API: GET /rest/api/3/search/jql?jql=key={issueKey}&expand=changelog
```

## Forge Actions

| Action | Purpose |
|---|---|
| `get-board-context` | Board details, active/future sprints, backlog overview |
| `get-sprint-issues` | All work items in a selected sprint with full changelog data |
| `assess-sprint` | Readiness and risk assessment with configurable deterministic rules |
| `explain-drift` | Investigates probable cause of estimate drift for a specific work item |

## Sprint Selection Flow

Both `assess-sprint` and `get-sprint-issues` support active and future sprints. When called without a `sprintId`, the action returns a list of available sprints. The agent matches the user's intent to the correct sprint by name, then calls again with the resolved ID.

## Assessment Rules

### Deterministic Rules (evaluated in code)

| Rule | Category | Default Threshold |
|---|---|---|
| Sprint has a meaningful name | Sprint Hygiene | Not matching `{KEY} Sprint {N}` pattern |
| Sprint has a goal | Sprint Hygiene | Non-empty |
| All work items have an assignee | Issue Readiness | 0% unassigned |
| All work items have an estimate | Issue Readiness | Inferred from changelog |
| No high-risk carry-overs | Carry-Over Risk | `sprintCount >= 3` |
| Work items have stable ownership | Ownership Stability | `reassignments < 3` |
| Work is distributed | Ownership Stability | No assignee > 40% of items |
| Estimates are stable | Estimate Stability | `revisions < 3` |
| No major estimate drift | Estimate Stability | `changePercent <= 50%` |
| No stale work items | Staleness | `ageDays <= 30` (non-Done) |
| Commitment aligns with recent velocity | Velocity | Current commitment vs 3-sprint completed avg |

### Non-deterministic Analysis (handled by the LLM)

- **Sprint goal suggestion**: When the goal rule fails, the LLM synthesises a suggested goal from work item summaries
- **Sprint name suggestion**: When the name rule fails, the LLM suggests a two-word name capturing the sprint's zeitgeist
- **Drift probable cause**: The `explain-drift` action returns scope changes (summary/description edits) near estimate changes; the LLM interprets the diff and assesses whether scope change explains the drift

### Custom Thresholds

Users can override default thresholds by pasting a YAML config in chat:

```yaml
carryOver:
  highRiskSprintCount: 3
ownership:
  maxReassignments: 3
  maxIssuePercentPerAssignee: 40
estimates:
  maxRevisions: 3
  maxDriftPercent: 50
staleness:
  maxAgeDays: 30
velocity:
  maxOverCommitPercent: 25
```

Partial overrides are supported — omitted keys fall back to defaults.

`velocity.maxOverCommitPercent` controls the commitment vs velocity rule. The rule fails when committed work items or points exceed the historical completed average by more than this percentage. Comparison is one-sided: under-commitment does not fail the rule.

## Signal Parsing

Each work item is assessed server-side by parsing its changelog:

| Signal | What it extracts |
|---|---|
| Carry-over count | Number of distinct sprints the work item has been in |
| Assignee changes | Count of reassignments with from/to/date |
| Estimate changes | Revisions bucketed into points and time, with latest drift and percentage change |
| Sprint age | Days since the work item was first assigned to any sprint |
| Has estimate | Whether an estimate was ever set (inferred from changelog) |

## Project Structure

```
src/
├── index.ts                  # Entry point — re-exports action handlers
├── boardContext.ts           # Orchestrator: get-board-context
├── sprintIssues.ts           # Orchestrator: get-sprint-issues
├── assessSprint.ts           # Orchestrator: assess-sprint
├── explainDrift.ts           # Orchestrator: explain-drift
├── signals.ts                # Signal parsing (pure logic, no API calls)
├── rules.ts                  # Deterministic rules engine with configurable thresholds
├── velocity.ts               # Velocity signal: sprint report parsing and commitment comparison
├── responses.ts              # Shared response types and mapping helpers
└── jira/
    ├── search.ts             # JQL search with changelog expansion
    └── software/
        └── board.ts          # Jira Software REST API (board, sprint, backlog, sprint report)
prompts/
└── agent-instructions.md     # External agent prompt (controls presentation)
test/
├── signals.test.ts           # Signal parsing tests
├── rules.test.ts             # Rules engine + config override tests
├── velocity.test.ts          # Velocity signal computation tests
├── responses.test.ts         # Structured response tests
└── explainDrift.test.ts      # Scope change parser tests
```

**Design principle:** Deterministic computation happens in code (signals, rules, thresholds). The LLM owns presentation and non-deterministic analysis. Actions return structured JSON; the agent-instructions.md shapes the user-facing output.

## Setup

### Prerequisites
- [Forge CLI](https://developer.atlassian.com/platform/forge/getting-started/) installed and logged in
- An Atlassian site with Jira Software
- A Scrum board in Jira Software

### 1. Clone and install dependencies

```bash
git clone https://github.com/ferrari-atlas/forge-rovo-sprint-assessment.git
cd forge-rovo-sprint-assignment
```

```bash
fnm use          # Uses .nvmrc
npm install
npm run build    # TypeScript compilation
```

### 2. Register, deploy and install

```bash
forge register
forge deploy --non-interactive -e development
forge install --non-interactive --site yoursite.atlassian.net --product jira --environment development
```

## OAuth Scopes

| Scope | Used by |
|---|---|
| `read:board-scope:jira-software` | Board details, backlog |
| `read:sprint:jira-software` | Sprint listing |
| `read:issue-details:jira` | Issue fields in search |
| `read:jql:jira` | JQL search execution |
| `read:jira-work` | `/rest/api/3/search/jql` endpoint |
| `read:jira-user` | User identity resolution |
| `read:chat:rovo` | Enables no-code agents to use actions |

## Known Blind Spots

- **Manual mid-sprint moves**: If a work item is moved between sprints while the source sprint is still active, the source sprint does not persist in the cumulative list.
- **Backlog removal + re-add**: Removing a work item to backlog and re-adding resets the sprint trail.
- **Changelog cap**: `expand=changelog` returns up to ~100 entries per work item. Older entries may be truncated.
- **Has-estimate inference**: Work items estimated at creation time (no changelog entry) are not detected as having an estimate.
- **Velocity rule logic**: Only evaluates over commitment in a sprint, does not fail for undercommitment, both issue count and story point (if applicable) needd to pass for rule to pass.
