# Pi regeneration history integrity

## Current behavior

This note records the regeneration integrity changes based on branch baseline `30f389c4e2af5eaa7c7ba2a7353c4f49b3370132`.

The `/api/agents/chat` admission middleware runs after the existing chat submission limiters, then loads the authorized conversation once before privacy inspection. It restores the source message's text, attachments, skills, quotes, and reasoning settings and stores the selected source-to-root parent chain in request-local state. `BaseClient.loadHistory` consumes that chain and checks its user, conversation, source message, and digest before exposing history to the rest of the client; it does not issue another conversation query. Siblings and descendants are not passed into the client history cache.

The parent-chain check excludes sibling and descendant messages. A missing parent, cycle, duplicate message ID, or row outside the authenticated user, tenant, and conversation fails closed. Legacy ancestors with no `parentMessageId` are treated as roots, matching the existing history walker. Admission checks run before Agent initialization. `BaseClient` binds its history walk to the admitted source message and conversation, consumes the snapshot once, and verifies the pinned branch before `onHistoryLoaded` and Pi dispatch. The digest covers the full source-to-root chain, including ancestors above a summary checkpoint. A database update after the query does not replace the pinned rows for the active request; it will be visible to the next request. The digest detects changes to the in-memory snapshot before use, but is not a storage lock or a MongoDB snapshot-read guarantee. The internal post-start error carries `PI_HISTORY_CONFLICT`, but propagation through the existing job/SSE error envelope still needs verification. There is no `message.regenerated` audit action yet.

The admission query still loads all messages in the scoped conversation without a projection or row cap. Its database, serialization, and memory cost under long histories and high regeneration concurrency is unmeasured; production capacity remains an open gate. The SA2 tests were intentionally red against an older `snapshotVersion`/audit contract and are not included in this branch. Their audit and storage-consistency requirements remain open work.

## Required behavior

1. Keep the server-owned snapshot bound to the persisted parent chain used for regeneration. It currently checks every ancestor through the root, including rows above a summary checkpoint. Continue including required tool results and excluding siblings, descendants, and unrelated conversations.
2. Keep one parent-chain rule for admission and `BaseClient.loadHistory`. The snapshot pins the ordered chain, and the client verifies and walks that same chain.
3. Keep branch selection before `next()`. Pin the rows returned by the scoped read in request-local state, then have `BaseClient.loadHistory` consume and verify that same branch. Avoid serial reads and do not pass partial or sibling history to the model. This preserves the selected read result; it does not promise transactional consistency across concurrent writes.
4. Bind every read to the authenticated user, tenant, conversation, and original message. Missing, cross-tenant, non-user, malformed, or unauthorized source rows return the same fixed not-found response without exposing persisted or submitted content. The client-side walk must stay bound to the admitted conversation and source message.
5. Record `message.regenerated` after the snapshot is confirmed and before `next()`. Store only actor, target message ID, conversation ID, and snapshot version. Do not store message text, attachment names or IDs, skill names, or reasoning values. If the required audit write fails, reject the admission before Agent initialization.
6. Keep a safe retryable `409 PI_HISTORY_CONFLICT` for internal snapshot/binding failures. If the job has already returned `started`, preserve a stable safe code through its job/SSE error contract; that outward mapping still needs implementation and verification.

The snapshot digest identifies the ordered selected rows. It is not a lock. Keep the snapshot and user data out of client-visible events and job metadata.

## Verification

- A client-supplied body cannot replace the stored source text, attachments, skills, quotes, or reasoning settings, including when a stored field is empty.
- Changes to persisted rows after the scoped read do not replace the current request's pinned branch; the next request observes those changes.
- A changed sibling or descendant does not invalidate the selected branch.
- A legacy root ancestor without `parentMessageId` remains usable, and a duplicate history consumption or mismatched client walk fails closed.
- The branch check and the final Pi prompt use the same ordered lineage and formatter rules.
- Unauthorized, missing, malformed, cross-tenant, and non-user source rows have the same response and do not initialize the Agent.
- Successful admission writes one content-free audit record. Audit failure blocks initialization. This is not implemented.
- A post-`started` conflict is visible through the existing job/SSE lifecycle with a stable safe code and does not expose exception text or transcript content. This remains unverified.

## Production gate

This work is separate from the deployment checks in [the production acceptance checklist](./pi-production-acceptance.md). Do not mark regeneration integrity complete until the focused tests pass against the real prompt construction seam and the same checks pass through the chat route.
