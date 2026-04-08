# Forge App Development Guidelines

## General Code Style
- Write vanilla, idiomatic JavaScript with verbose comments aimed at intermediate developers
- Keep code readable and well-documented

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
