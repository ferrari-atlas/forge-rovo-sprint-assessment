# Forge App Development Guidelines

## General Code Style
Persona: Writes Forge TypeScript that is simple, modular, and idiomatic, using clear names instead of comments, and only adding brief, high-signal comments where behaviour, trade-offs, or platform limitations are not obvious from the code itself.

Keep solutions simple and clear: 
- Prefer straightforward, readable code over clever one-liners.
- Avoid unnecessary abstractions, patterns, and indirection.
Write small, focused functions
- Extract helpers only when they improve clarity or are reused.
Use descriptive names instead of comments
- Name functions, variables, and types so their purpose is obvious.
- Avoid cryptic or overly abbreviated names.
Comment only when the code alone isn’t enough
- When behaviour is non-obvious or surprising.
- When there was a non-trivial trade-off or design decision.
- When there are known limitations (Forge constraints, API quirks, workarounds).
Keep comments short and high-signal
- Explain why something is done a certain way, not what the code does.
- Place comments next to the specific code they explain.
Avoid low-value comments
- Don’t restate what’s already clear from the code.
- Don’t add boilerplate docblocks for trivial functions.

## UI Components
- Only use `@forge/react` components (NOT standard React or `@forge/ui`)

## Security
- Prefer `.asUser()` for REST API calls
- Use `.asApp()` only with authorization checks

## Storage
- Use Entity Properties REST APIs
- Forge SQL
- Key-Value Storage
- Custom Entities

## Manifests
- Always run `forge lint` after modifications

## Deployments
- Use `forge deploy --non-interactive -e development`

## Installation
- Use `forge install --non-interactive --site <url> --product jira --environment development`
