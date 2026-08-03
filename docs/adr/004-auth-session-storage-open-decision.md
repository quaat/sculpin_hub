# ADR 004: Authentication session storage

- **Status:** Open; authentication is outside the foundation slice
- **Date:** 2026-08-03

## Context

The implementation plan recommended Auth.js but also assumed hashed opaque database session identifiers. That combination has not been verified against current Auth.js database-session behavior and must not cause a custom protocol by accident.

## Decision

Before implementing authentication, verify current Auth.js provider, adapter, cookie, rotation, revocation, and database-session behavior against official documentation and source. Determine whether the normal supported session model meets the threat model. Evaluate a custom adapter only if a documented security gap remains. Prefer an established, supportable library configuration; do not implement custom OAuth or session protocols merely to preserve an unverified assumption.

## Alternatives

A managed identity platform may better satisfy administrative MFA/assurance. Custom sessions offer control but increase security and maintenance risk. JWT sessions change revocation characteristics.

## Consequences

Google and LinkedIn login remain disabled. No session schema or authentication dependency is introduced in the foundation.

## Security considerations

The later ADR must address state, nonce, PKCE, issuer/audience, redirect allowlists, linking, fixation, expiry/rotation/revocation, CSRF, secure cookies, provider-token retention, and administrative assurance.

## Follow-up decisions

Choose identity library/provider registrations, session strategy, adapter, expiry SLOs, MFA assurance, and account-link policy in a focused identity PR.
