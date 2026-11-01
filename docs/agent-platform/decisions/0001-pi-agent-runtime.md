# ADR 0001: Make Pi the Agent runtime

- Status: Accepted for `feature/pi-agent-runtime`; production deployment is not validated.
- Date: 2026-11-01

## Context

The product runs Agent requests inside each customer's LibreChat server. Pi provides the agent loop, model adapters, tools and in-memory sessions needed for server-side execution. The server still owns user and tenant admission, Agent definitions, credentials, authorization, approvals, durable jobs, events, messages, artifacts and audit records.

Keeping two Agent engines in this branch would leave users dependent on a runtime selector and make an unavailable Pi configuration silently retain the old behavior. The branch will use Pi as its only Agent execution engine. It will not fall back to the previous Agent engine when Pi rejects a graph, provider, tool or lifecycle mode.

## Decision

Every new supported Agent chat generation is pinned to Pi SDK `1.4.0` before execution. Pi runs in the LibreChat server with one isolated session and request-scoped model binding per generation. LibreChat remains authoritative for the transcript; Pi session state is temporary.

The existing desktop and Web chat entry points, host authorization, `GenerationJobManager`, Redis event transport, approval CAS, SSE events, conversation storage and message persistence remain the product boundaries. Pi translates its model and tool events into the host's existing event handlers. It does not write SSE or durable conversation records directly.

Old Agent generations and pause records do not resume through another engine. A stored generation identity is immutable; an old identity is never reinterpreted as Pi. New Agent requests write the Pi identity explicitly. Generic schedules, MCP and other non-Agent jobs leave the Agent runtime identity unset and retain their generic provider lifecycle.

The OpenAI-compatible Agent Chat Completions and Agent Responses endpoints keep their request and response contracts but call the Pi dispatcher through host-owned projection adapters. Provider Assistants API routes are separate provider APIs and are not Agent runtime entry points. This branch does not maintain the old Agent engine as a fallback.

Pi's local shell, filesystem tools, automatic resource discovery, terminal UI and project extension loading remain disabled. Code execution uses the existing authorized Code API. MCP and Action tools use host authorization and execution handlers. The server rejects a configuration unless a reviewed Pi adapter can preserve its credentials, permissions and lifecycle.

## Consequences

- Main Agent chat always attempts Pi; unsupported graphs, providers, tools and lifecycle modes fail with a stable unavailable-runtime error.
- Existing transcripts remain readable as LibreChat data. Paused Legacy Agent jobs are not migrated or resumed by Pi.
- No Pi failure falls through to the previous engine. Operators can roll back by deploying the previous application release, outside this branch's runtime behavior.
- Code API isolation, tenant ACLs, production multi-replica recovery and performance against the target deployment remain deployment verification gates. Local tests do not prove those controls.
- The capability matrix and [Pi runtime integration record](../pi-agent-runtime.md) track implemented behavior and remaining gaps.

## Verification before production

1. Verify supported chat, tool, attachment, approval, cancellation and restored-history flows in desktop and Web clients.
2. Verify provider credential provenance and fail-closed behavior for every enabled provider.
3. Verify Redis owner fencing, process-loss recovery, restart and multi-replica behavior.
4. Verify the deployed Code API sandbox, tenant ACL, audit trail and artifact handling.
5. Compare Pi throughput, p50/p95 latency, error rate, CPU and memory with the production Legacy baseline in the target deployment shape.
