# Forge Rovo Sprint Assessment

A Forge app providing a Rovo agent with actions for analysing Jira Software sprints. The agent retrieves board context, sprint issue data, and structured risk assessments by calling the Jira Software REST API and parsing changelogs server-side.

All actions return structured JSON data. The agent prompt controls how results are presented to users. Deterministic rules are evaluated in code; non-deterministic analysis (goal suggestions, drift interpretation) is handled by the LLM using the structured data.

## Actions

| Action | Purpose |
|---|---|
| `get-board-context` | Board details, active/future sprints, backlog overview |
| `get-sprint-issues` | All issues in a selected sprint with full changelog data |
| `assess-sprint` | Readiness and risk assessment with configurable deterministic rules |
| `explain-drift` | Investigates probable cause of estimate drift for a specific issue |

## Sprint Selection Flow

Both `assess-sprint` and `get-sprint-issues` support active and future sprints. When called without a `sprintId`, the action returns a list of available sprints. The agent matches the user's intent to the correct sprint by name, then calls again with the resolved ID.

## Assessment Rules

### Deterministic Rules (evaluated in code)

| Rule | Category | Default Threshold |
|---|---|---|
| Sprint has a meaningful name | Sprint Hygiene | Not matching `{KEY} Sprint {N}` pattern |
| Sprint has a goal | Sprint Hygiene | Non-empty |
| All issues have an assignee | Issue Readiness | 0% unassigned |
| All issues have an estimate | Issue Readiness | Inferred from changelog |
| No high-risk carry-overs | Carry-Over Risk | `sprintCount >= 3` |
| Issues have stable ownership | Ownership Stability | `reassignments < 3` |
| Work is distributed | Ownership Stability | No assignee > 40% of items |
| Estimates are stable | Estimate Stability | `revisions < 3` |
| No major estimate drift | Estimate Stability | `changePercent <= 50%` |
| No stale issues | Staleness | `ageDays <= 30` (non-Done) |

### Non-deterministic Analysis (handled by the LLM)

- **Sprint goal suggestion**: When the goal rule fails, the LLM synthesises a suggested goal from issue summaries
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
```

Partial overrides are supported — omitted keys fall back to defaults.

## Signal Parsing

Each issue is assessed server-side by parsing its changelog:

| Signal | What it extracts |
|---|---|
| Carry-over count | Number of distinct sprints the issue has been in |
| Assignee changes | Count of reassignments with from/to/date |
| Estimate changes | Revisions bucketed into points and time, with latest drift and percentage change |
| Sprint age | Days since the issue was first assigned to any sprint |
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
├── responses.ts              # Shared response types and mapping helpers
└── jira/
    ├── search.ts             # JQL search with changelog expansion
    └── software/
        └── board.ts          # Jira Software REST API (board, sprint, backlog)
prompts/
└── agent-instructions.md     # External agent prompt (controls presentation)
test/
├── signals.test.ts           # Signal parsing tests
├── rules.test.ts             # Rules engine + config override tests
├── responses.test.ts         # Structured response tests
└── explainDrift.test.ts      # Scope change parser tests
```

**Design principle:** Deterministic computation happens in code (signals, rules, thresholds). The LLM owns presentation and non-deterministic analysis. Actions return structured JSON; the prompt shapes the user-facing output.

## Response Contract

All actions return a consistent envelope:

```typescript
// Success
{ ok: true, action: "<name>", data: { ... } }

// Sprint selection required
{ ok: true, action: "<name>", selectionRequired: true, data: { availableSprints: [...] } }

// Error
{ ok: false, action: "<name>", error: { code: "<CODE>", message: "..." } }
```

## Setup

```bash
fnm use          # Uses .nvmrc
npm install
npm run build    # TypeScript compilation
npm test         # Run unit tests (118 tests)
```

## Deployment

```bash
forge deploy --non-interactive -e development
forge install --non-interactive --site <site>.atlassian.net --product jira --environment development
```

Use `--upgrade` when adding new scopes.

## Development

```bash
forge tunnel -e development
```

## Key Development Patterns

### Authentication: `asApp()` vs `asUser()`

Rovo agent actions set `userAccess.enabled: false` by default. This means `asUser()` will fail with `NEEDS_AUTHENTICATION_ERR`. Always check the flag:

```typescript
import { asApp, asUser } from "@forge/api";

function getAuth(context?: { userAccess?: { enabled: boolean } }) {
  if (context?.userAccess?.enabled) return asUser();
  return asApp();
}
```

### The `toString` Property Trap

The Jira changelog API returns items with a property literally named `"toString"`. Always use bracket notation:

```typescript
function getToString(item: ChangelogItem): string | null {
  return (item as unknown as Record<string, string | null>)["toString"] ?? null;
}
```

### Jira REST API Endpoint Versions

Forge apps using granular OAuth scopes must use `/rest/api/3/search/jql` (not `/rest/api/3/search` which returns `410 Gone`).

### Board Configuration Endpoint

`/rest/agile/1.0/board/{id}/configuration` requires a scope that does not exist in Forge's scope registry. Currently inaccessible from Forge apps.

### Structured Response Pattern

Actions return typed objects, not formatted strings. The prompt interprets and presents the structured data:

```typescript
export async function myAction(payload): Promise<ActionResponse> {
  const data = await fetchData(payload);
  const signals = parseSignals(data);
  const rules = evaluateRules(signals);
  return { ok: true, action: "my-action", data: { signals, rules } };
}
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

## Adding a New Action

1. Create the API function in `src/jira/` (if new endpoint needed)
2. Create the orchestrator in `src/` (follow existing pattern)
3. Add response types to `src/responses.ts`
4. Export from `src/index.ts`
5. Add `action`, `function`, and agent reference in `manifest.yml`
6. Update `prompts/agent-instructions.md`
7. Add tests if the action includes parsing logic
8. Run `forge lint`, `npx tsc`, `npm test`
9. Deploy and upgrade

## Known Blind Spots

- **Manual mid-sprint moves**: If an issue is moved between sprints while the source sprint is still active, the source sprint does not persist in the cumulative list.
- **Backlog removal + re-add**: Removing an issue to backlog and re-adding resets the sprint trail.
- **Changelog cap**: `expand=changelog` returns up to ~100 entries per issue. Older entries may be truncated.
- **Has-estimate inference**: Issues estimated at creation time (no changelog entry) are not detected as having an estimate.
