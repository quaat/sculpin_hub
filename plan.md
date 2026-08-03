## Prompt for Codex

```text
You are a senior software architect, security engineer, SaaS platform designer, and technical delivery lead.

Create a detailed, implementation-ready development plan for the first production version of the **Sculpin Knowledge Hub**.

Do not start implementing the application yet. First inspect the existing repository, documentation, configuration, and test setup. Then produce a plan that another Codex development session can execute incrementally.

The attached UI mockup is a visual and product-direction reference. It is not a complete technical specification. Preserve its clean, professional SaaS appearance, but prioritize security, correctness, maintainability, and a well-defined MVP.

# 1. Product objective

The Sculpin Knowledge Hub will provide managed access to products and agents exposed through the Sculpin API.

It must allow users and organizations to:

1. Register and sign in using an existing Google or LinkedIn account.
2. Browse publicly available Sculpin products.
3. subscribe to a free or paid plan for a product.
4. Receive usage limits, such as:
   - Requests per month
   - Token or credit limits
   - Optional request-rate limits
   - Optional product-specific limits
5. Create, list, rename, revoke, and delete API access tokens.
6. Use access tokens as bearer tokens with an OpenAI API-compatible proxy.
7. See subscription, token, and usage information in a dashboard.
8. Send API requests through the Knowledge Hub to the underlying Sculpin API.
9. Prevent requests when the token is invalid, the subscription is inactive, or the usage limit has been reached.
10. Record usage through an accounting or metering API.

The service must never persist plaintext API tokens after they have been issued.

# 2. Core request flow

Design the platform around the following request flow:

1. A client sends an OpenAI API-compatible request to the Knowledge Hub using:

   Authorization: Bearer <access-token>

2. The Knowledge Hub:
   - Parses and validates the bearer token format.
   - Locates the token record efficiently.
   - Cryptographically verifies the token without storing its plaintext value.
   - Verifies that the token is active and has not expired or been revoked.
   - Resolves the owning user, organization, subscription, plan, and product.
   - Verifies that the subscription is active.
   - Checks the accounting or metering API for available usage.
   - Enforces rate limits and concurrent-request limits.
   - Reserves usage when necessary to avoid race conditions.
   - Proxies the request to the correct Sculpin API endpoint.
   - Supports normal JSON responses and streaming responses.
   - Records final usage based on the upstream response.
   - Reconciles or releases reserved usage when the request fails.
   - Returns an OpenAI-compatible success or error response.

3. The underlying Sculpin API credential must remain server-side and must never be exposed to the client.

The plan must explain how the flow remains correct under concurrent requests, retries, timeouts, streaming disconnects, duplicate accounting events, and partial failures.

# 3. Repository assessment

Before proposing the architecture:

1. Inspect the repository structure.
2. Identify:
   - Existing frontend and backend frameworks
   - Authentication functionality
   - Database models and migrations
   - API conventions
   - Configuration management
   - Existing Sculpin API integration
   - Existing accounting or billing integration
   - Test frameworks
   - Container and deployment configuration
   - CI/CD workflows
3. Separate:
   - Components that can be reused
   - Components that require extension
   - Components that should be replaced
   - Missing components
4. Do not invent existing functionality.
5. Reference relevant `file`, `directory`, `class`, and `function` names from the repository when describing proposed work.
6. Clearly state assumptions where the repository or requirements are incomplete.

# 4. Architecture to evaluate

Develop a recommended architecture and briefly compare reasonable alternatives.

At minimum, evaluate the following components.

## 4.1 Web application

The web application should support:

- Public landing page
- Product catalog
- Product details and plan comparison
- Google and LinkedIn sign-in
- User onboarding
- Dashboard
- Subscription management
- API token management
- Usage overview
- Billing overview
- Account settings
- Organization and team support, even if advanced team administration is deferred
- Administrative product and plan management

Prefer a modern, responsive interface matching the attached mockup.

If the repository does not already establish a frontend stack, evaluate a suitable stack such as:

- Next.js
- React
- TypeScript
- Tailwind CSS
- A well-supported component system

Do not select technology solely because it appears in this prompt. Base the recommendation on the existing repository and project constraints.

## 4.2 Backend control-plane API

The control plane should handle:

- User and identity management
- Organizations and memberships
- Product catalog
- Plans and entitlements
- Subscriptions
- Billing integration
- Access-token lifecycle
- Usage reporting
- Administrative operations
- Audit logs

Evaluate whether this belongs in the same deployable service as the proxy or in a separately scalable service.

## 4.3 OpenAI-compatible data-plane proxy

The proxy should be optimized and isolated for API traffic.

It should support at least the initial Sculpin-compatible OpenAI endpoints required by the existing Sculpin API. Determine the exact endpoint scope from the repository and upstream API.

Likely examples include:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Do not claim support for endpoints that the Sculpin API does not implement.

The proxy design must address:

- Streaming via Server-Sent Events
- Request and response size limits
- Connection and upstream timeouts
- Cancellation when the client disconnects
- Header allowlists
- Removal of hop-by-hop headers
- Prevention of arbitrary upstream URL selection
- Safe forwarding of query parameters
- OpenAI-compatible error bodies
- Correlation IDs
- Structured logging
- Redaction of credentials and sensitive prompts where appropriate
- Per-token and per-subscription rate limiting
- Concurrency limits
- Circuit breaking and upstream health handling
- Backpressure
- Horizontal scaling

## 4.4 Persistent storage

Recommend a relational database design, preferably PostgreSQL unless the repository establishes another suitable database.

The plan must propose entities and relationships for at least:

- `User`
- `ExternalIdentity`
- `Organization`
- `OrganizationMembership`
- `Product`
- `ProductVersion` or upstream product configuration
- `Plan`
- `PlanEntitlement`
- `Subscription`
- `ApiToken`
- `UsagePeriod`
- `UsageReservation`
- `UsageEvent`
- `BillingCustomer`
- `BillingSubscription`
- `WebhookEvent`
- `AuditEvent`

For each important entity, describe:

- Purpose
- Important fields
- Unique constraints
- Indexes
- Foreign-key behavior
- Lifecycle and retention requirements
- Tenant-isolation considerations

The design should allow one product to expose one or more Sculpin agents or upstream model identifiers without leaking internal configuration to clients.

## 4.5 Cache and rate limiting

Evaluate whether Redis or another shared, atomic store is needed for:

- Rate limiting
- Concurrency control
- Short-lived entitlement caching
- Revocation caching
- Idempotency
- Distributed locks
- Usage reservations

The database or accounting service must remain authoritative. The plan must explain cache invalidation and behavior when the cache is unavailable.

# 5. Authentication and identity

Create a secure design for Google and LinkedIn login.

The plan must cover:

- OAuth 2.0 and OpenID Connect where supported
- Authorization Code flow
- PKCE where applicable
- `state` and `nonce` validation
- Redirect URI validation
- Account linking
- Duplicate-email handling
- Whether verified email addresses may be trusted for linking
- Session storage and expiration
- CSRF protection
- Secure cookies
- Logout
- Provider-token storage and encryption
- User deactivation
- Administrative role management

Use an established identity solution or authentication library rather than implementing OAuth protocols manually.

Verify current Google and LinkedIn requirements using their official documentation before implementation.

# 6. API access-token security

Design a token format suitable for identifying and validating tokens securely and efficiently.

The token design should consider:

- A human-recognizable environment or product prefix
- A non-secret token identifier
- A cryptographically random secret
- At least 256 bits of generated entropy
- One-time display of the complete token
- Only a safe prefix or suffix shown later
- Hashing or keyed hashing of the secret
- Server-side pepper or HMAC key held in a secret manager
- Constant-time comparison where applicable
- Key rotation
- Token expiration
- Revocation
- Last-used timestamps
- Optional scopes
- Optional product restrictions
- IP restrictions only as a possible future feature
- Audit events

Do not store plaintext tokens in logs, analytics, traces, browser storage, database fields, or error messages.

Explain whether a slow password hash or an HMAC-based verifier is preferable for high-entropy machine-generated API tokens and why.

The implementation plan must include tests proving that:

- The complete token is returned only once.
- Database contents cannot be used directly as bearer credentials.
- Logs do not contain token values.
- Revoked tokens stop working promptly.
- Tokens cannot access products outside their entitlements.
- Token lookup remains efficient at scale.

# 7. Product, plan, and subscription model

Create a model supporting:

- Public and private products
- Free and paid plans
- Monthly and optional annual billing
- Trial periods
- Product-specific entitlements
- Request limits
- Token or credit limits
- Rate limits
- Maximum active tokens
- Maximum concurrent requests
- Plan upgrades and downgrades
- Subscription cancellation
- End-of-period cancellation
- Grace periods
- Suspended and past-due states
- Administrative overrides
- Future organization-level subscriptions

Define which component is authoritative for:

- Subscription state
- Billing state
- Product entitlements
- Usage totals
- Rate-limit state

Avoid duplicating business truth across several systems without a reconciliation strategy.

# 8. Billing and paid subscriptions

Evaluate a payment provider suitable for recurring SaaS subscriptions, such as Stripe, unless an existing provider is already established.

The plan must include:

- Hosted checkout or equivalent
- Customer portal
- Product and price mapping
- Free subscriptions without payment details
- Subscription webhook handling
- Signature verification
- Idempotent webhook processing
- Out-of-order webhook handling
- Replay protection
- Failed-payment handling
- Cancellation and reactivation
- Refund considerations
- Tax and VAT considerations
- Currency configuration
- Reconciliation jobs
- Test-mode development

Do not treat a browser redirect from checkout as proof that payment succeeded. Subscription state must be updated from verified server-side events or authoritative provider queries.

Mark legal, tax, and invoicing requirements that require business clarification rather than making unsupported assumptions.

# 9. Accounting and usage metering

The Knowledge Hub will check an external accounting API before proxying requests.

Because the exact API contract may not yet be available:

1. Define an internal accounting interface.
2. Isolate the external service behind an adapter.
3. Propose a mock implementation for local development and testing.
4. Define the expected operations, such as:
   - Resolve current entitlement
   - Check remaining allowance
   - Reserve usage
   - Commit final usage
   - Release a reservation
   - Retrieve current usage summary
5. Define idempotency keys for every usage operation.
6. Define behavior for:
   - Accounting service timeout
   - Temporary outage
   - Duplicate requests
   - Concurrent requests near a limit
   - Unknown final token usage
   - Streaming requests
   - Client disconnects
   - Upstream retries
   - Reservation expiration
   - Delayed reconciliation

Prefer fail-closed behavior for paid or quota-controlled access unless a deliberately bounded fallback policy is approved.

Explain how to prevent a check-then-act race where several simultaneous requests all pass the same remaining-usage check.

Clarify whether the accounting unit is:

- Request count
- Input tokens
- Output tokens
- Total tokens
- Product-specific credits
- Compute duration
- A combination of these

If this is not yet defined, make it an explicit decision point.

# 10. Sculpin upstream integration

Create a dedicated upstream adapter rather than scattering Sculpin-specific calls throughout the application.

The adapter must cover:

- Upstream base URL
- Server-side credentials
- Product-to-agent or product-to-model routing
- Request transformation
- Response transformation
- Streaming
- Timeouts
- Retries only when semantically safe
- Error normalization
- Health checks
- Correlation IDs
- Usage extraction
- Compatibility testing

Investigate the current Sculpin API contract from the repository or available documentation.

Identify any differences from the official OpenAI API contract and document how the proxy will handle them without misleading clients.

# 11. Security requirements

Include a threat model covering at least:

- Stolen API tokens
- Credential leakage through logs
- OAuth account-takeover scenarios
- Cross-tenant data access
- Insecure direct object references
- Subscription or entitlement bypass
- Replay attacks
- Brute-force token attempts
- Denial-of-service attacks
- Oversized request bodies
- Slow clients
- SSRF
- Header injection
- Open redirects
- Webhook forgery
- Race conditions in usage accounting
- Database compromise
- Secret exposure
- Administrative privilege escalation
- Supply-chain risk

The plan must specify mitigations such as:

- Tenant-scoped authorization checks
- Least-privilege service identities
- Encryption in transit and at rest
- Managed secret storage
- Key rotation
- Content Security Policy
- Secure HTTP headers
- Input validation
- API schema validation
- Rate limiting before expensive database or upstream operations
- Audit trails
- Dependency scanning
- Static analysis
- Container scanning
- Backup and restore testing
- Administrative MFA where supported

Do not log complete prompts, completions, authorization headers, OAuth tokens, payment data, or upstream credentials by default.

# 12. Administrative functionality

Define a minimal administrative interface that permits authorized administrators to:

- Create and update products
- Configure upstream Sculpin routing
- Publish or unpublish products
- Create and update plans
- Configure limits and entitlements
- View subscriptions
- Suspend access
- Revoke tokens
- Inspect usage
- Review audit logs
- Diagnose failed proxy requests without seeing secrets
- Manage product visibility

Recommend a bootstrap process for the first administrator that is safe and auditable.

# 13. Observability and operations

The production plan must include:

- Structured logs
- Request IDs and trace IDs
- Metrics
- Distributed tracing
- Health endpoints
- Readiness checks
- Dependency health
- Usage and billing reconciliation metrics
- Security alerts
- Token-authentication failure metrics
- Proxy latency
- Upstream latency
- Streaming duration
- Error rates by normalized category
- Accounting reservation leaks
- Queue or webhook backlog
- Subscription-state drift

Propose service-level objectives for:

- Control-plane availability
- Proxy availability
- Proxy latency overhead
- Token revocation propagation
- Usage-accounting accuracy

Also describe:

- Backup strategy
- Disaster recovery
- Database migrations
- Zero-downtime deployment considerations
- Rollback strategy
- Secret rotation
- Data retention
- GDPR-related export and deletion workflows

# 14. Deployment architecture

Provide a deployment recommendation suitable for an initial production version and future growth.

Consider:

- Containerized services
- Managed PostgreSQL
- Managed Redis
- Secret manager
- Reverse proxy or API gateway
- WAF
- TLS termination
- Separate public web, control-plane, and proxy workloads
- Autoscaling
- Private connectivity to the Sculpin API where appropriate
- Development, staging, and production environments
- Infrastructure as code
- CI/CD
- Database migration jobs
- Background workers for webhooks and reconciliation

If Azure is the intended target, provide an Azure-oriented recommendation while keeping application-layer components portable where practical.

Explicitly address secure connectivity from the hosted Knowledge Hub to an on-premises or otherwise restricted Sculpin API. Compare suitable options such as private networking, VPN, application proxy, or an outbound-initiated secure tunnel. Do not recommend exposing the Sculpin API directly to the public internet without a justified security design.

# 15. Testing strategy

Create a test strategy containing:

## Unit tests

- Token generation and verification
- Entitlement evaluation
- Plan-limit calculations
- Subscription-state transitions
- Error normalization
- Header filtering
- Accounting idempotency
- Product routing

## Integration tests

- Database persistence and migrations
- OAuth callbacks using test doubles
- Billing webhooks
- Accounting adapter
- Sculpin upstream adapter
- Redis rate limiting
- Token revocation
- Streaming proxy behavior

## End-to-end tests

- User registration and login
- Free subscription
- Paid checkout in test mode
- Token creation
- Successful proxied request
- Streaming request
- Invalid token
- Revoked token
- Inactive subscription
- Exhausted request limit
- Concurrent requests at the final available quota
- Subscription upgrade
- Cancellation
- Administrative suspension

## Security tests

- Tenant-isolation tests
- Authorization bypass attempts
- Secret-redaction tests
- Header-injection tests
- SSRF tests
- Replay and webhook-signature tests
- Oversized-payload tests
- Rate-limit tests
- Dependency and container scans

## Contract tests

- OpenAI-compatible API responses
- Sculpin upstream compatibility
- Accounting API compatibility
- Billing provider compatibility

Include deterministic test doubles for external services so the core test suite does not depend on live Google, LinkedIn, payment, accounting, or Sculpin environments.

# 16. Proposed MVP boundaries

Keep the first version focused.

The recommended MVP should include:

- Google and LinkedIn login
- Public product catalog
- Free and paid plans
- One payment provider
- Individual user subscriptions
- API token management
- OpenAI-compatible proxy for confirmed Sculpin endpoints
- Request and usage enforcement
- Basic dashboard
- Basic administration
- Auditing
- Production observability
- Secure deployment

Identify features that should likely be deferred, such as:

- Complex enterprise contracts
- Multi-currency support
- Advanced invoicing
- Fine-grained custom RBAC
- User-defined upstream routing
- Reseller support
- Multiple payment providers
- Full analytics warehouse
- Advanced IP allowlists
- Bring-your-own Sculpin credentials
- Marketplace revenue sharing

Do not defer security, tenant isolation, accounting correctness, migrations, tests, or operational readiness.

# 17. Implementation phases

Break the implementation into small, reviewable phases.

For each phase, provide:

- Objective
- Dependencies
- Repository areas affected
- New modules or services
- Database migrations
- API endpoints
- UI routes and components
- Security considerations
- Tests
- Documentation
- Deployment changes
- Acceptance criteria
- Expected risks

A suggested sequencing to evaluate is:

1. Repository assessment and architecture decisions
2. Project foundations and local environment
3. Identity and user model
4. Product catalog and plan model
5. Subscription state machine
6. API-token lifecycle
7. Accounting adapter and usage model
8. OpenAI-compatible proxy
9. Sculpin upstream adapter
10. Free subscription flow
11. Paid subscription and webhook processing
12. User dashboard
13. Administrative interface
14. Observability and security hardening
15. Deployment and operational readiness
16. Production-readiness review

Adjust the sequence if repository dependencies justify a better order.

# 18. Required API design

Propose the initial control-plane API surface.

At minimum, evaluate endpoints for:

- Authentication/session information
- Current user
- Products
- Plans
- Subscriptions
- Checkout
- Billing portal
- API tokens
- Usage
- Organizations
- Administration
- Billing webhooks
- Health and readiness

For each endpoint group, describe:

- Authentication requirements
- Authorization requirements
- Request and response schemas
- Idempotency requirements
- Expected errors

Also document the public OpenAI-compatible proxy surface separately from the dashboard/control-plane API.

# 19. Required state machines

Define explicit state machines for:

## Subscription

Potential states may include:

- `pending`
- `trialing`
- `active`
- `past_due`
- `suspended`
- `cancel_at_period_end`
- `canceled`
- `expired`

Use only states that are justified by the final design.

## API token

Potential states may include:

- `active`
- `expired`
- `revoked`

## Usage reservation

Potential states may include:

- `reserved`
- `committed`
- `released`
- `expired`

Specify valid transitions, transition owners, idempotency rules, and invalid-transition behavior.

# 20. Acceptance criteria for the plan

The plan is complete only when it:

1. Is grounded in the inspected repository.
2. Clearly separates confirmed facts, recommendations, assumptions, and open decisions.
3. Defines the control plane and data plane.
4. Includes a concrete data model.
5. Includes secure API-token handling.
6. Defines concurrent usage-limit enforcement.
7. Handles streaming OpenAI-compatible requests.
8. Defines failure behavior for the accounting and Sculpin APIs.
9. Includes free and paid subscription flows.
10. Includes billing webhook security and idempotency.
11. Includes tenant isolation.
12. Includes testing, deployment, observability, and operational readiness.
13. Breaks implementation into reviewable pull requests or milestones.
14. Provides measurable acceptance criteria for every phase.
15. Identifies unresolved business and technical decisions without blocking all progress.

# 21. Deliverable format

Produce a single detailed Markdown document named:

`docs/sculpin-knowledge-hub-implementation-plan.md`

Use the following structure:

1. Executive summary
2. Repository assessment
3. Confirmed requirements
4. Assumptions and open questions
5. MVP scope
6. Out-of-scope items
7. Recommended architecture
8. Alternative architectures considered
9. Trust boundaries and threat model
10. Authentication and identity design
11. Product, plan, and subscription design
12. API-token security design
13. Accounting and metering design
14. OpenAI-compatible proxy design
15. Sculpin upstream integration
16. Data model
17. API surface
18. State machines
19. User-interface structure
20. Administrative functionality
21. Billing integration
22. Observability and operations
23. Deployment architecture
24. Testing strategy
25. Migration and rollout strategy
26. Implementation phases
27. Pull-request breakdown
28. Risks and mitigations
29. Architecture decision records required
30. Definition of done
31. Prioritized open questions

Include:

- Mermaid component diagrams
- Mermaid sequence diagrams for:
  - Login
  - Free subscription
  - Paid checkout and webhook activation
  - Token creation
  - Successful proxied request
  - Streaming proxied request
  - Quota rejection
  - Accounting-service failure
- A proposed database relationship diagram
- Tables for:
  - Entitlement ownership
  - Failure modes
  - Error mapping
  - Security controls
  - Implementation phases
  - Pull-request sequence

# 22. Planning behavior

While creating the plan:

- Do not write production implementation code.
- Small pseudocode fragments or interface sketches are acceptable when they clarify an architectural decision.
- Do not introduce unnecessary microservices.
- Do not use a local-only in-memory design for production-critical state.
- Do not implement OAuth, cryptography, payment processing, or token hashing from scratch.
- Prefer established, actively maintained libraries.
- Verify security-sensitive library and provider behavior against current official documentation.
- Avoid speculative support for unconfirmed Sculpin or OpenAI endpoints.
- Identify decisions that require stakeholder input.
- For each open question, recommend a safe default that allows development to proceed.
- Ensure the resulting plan can be handed directly to Codex for phased implementation.
```
