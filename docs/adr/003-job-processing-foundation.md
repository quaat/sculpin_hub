# ADR 003: Job processing foundation

- **Status:** Accepted for foundation
- **Date:** 2026-08-03

## Context

Future webhooks and reconciliation need durable jobs committed with business changes. Local development must not require a cloud queue, and no business job exists yet.

## Decision

Expose small provider-neutral job identity, payload, attempt, claim, completion, retryable-failure, and terminal-failure types in `packages/jobs`. Prefer a PostgreSQL transactional outbox and worker polling in the next data phase. Claim rows atomically with `SELECT ... FOR UPDATE SKIP LOCKED`, bounded batches, claim owner/lease, attempt limits, and idempotent handlers. The foundation idle runner does not poll when no handler exists.

## Alternatives

An in-memory queue is not durable. A generic job framework can obscure transaction ownership. Azure Service Bus may suit production topology but is not required locally and has not been selected.

## Consequences

The seam is testable without inventing jobs or tables. The first business-event migration will implement the outbox and safe row claiming. Azure Service Bus remains a deployment option in an infrastructure ADR, potentially fed through the outbox.

## Security considerations

Payloads must be schema-validated, tenant-scoped, minimal, and secret-free. Claims need least-privilege database access; poison jobs need bounded retries and audited terminal failure.

## Follow-up decisions

Define outbox schema/retention, polling latency, idempotency policy, and whether production additionally publishes to Service Bus.
