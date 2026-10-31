# Design

ChatGPT Alerts separates provider ingestion from delivery. The only implemented provider
is Grafana; adding another provider does not require provider-specific MCP tools or events.

## Integration boundary

`src/integrations/` owns webhook authentication and provider payload validation. An adapter
implements `Integration.receive` and returns normalized `Alert` records. Register it in
`integrations/index.ts`. Source configuration selects an adapter and provides a source ID,
display name and independent webhook secret. Unknown adapters fail startup.

Core code knows sources, normalized alerts and subscriptions. It does not parse Grafana
payloads or assume provider-specific labels. The canonical data carries integration,
source, fingerprint, status, name, optional severity, labels, annotations, occurrence timestamps and links.
Provider metadata is untrusted data and cannot grant execution authority.

Stable content-derived IDs deduplicate equivalent normalized records. Each accepted
notification is committed transactionally. A mixed Grafana batch uses each alert's state,
not just the group's state. Unset Grafana end timestamps are omitted from firing events.

## MCP and host responsibilities

The official SDK implements discovery, initialization, tool schemas and HTTP transport.
The same server factory serves modern MCP and legacy Streamable HTTP, avoiding a second
handwritten compatibility adapter. The only custom protocol surface is the draft MCP
Events webhook subset: `events/list`, `events/subscribe`, and `events/unsubscribe`.

The host creates and refreshes subscriptions. The server grants at most one hour, capped
by the caller's authorization expiry. `ttlMs: null` receives the finite default. Stable
subscription identity includes the principal, event, filters and callback URL; refreshes
update the same row. `maxAgeMs`, polling and streaming event subscriptions are unsupported.

Callbacks are verified by a signed challenge. Outbound delivery uses Standard Webhooks,
fresh attempt timestamps and stable event IDs. Callback destinations require HTTPS;
private/special-use IPs and DNS answers are rejected, the connection is pinned to a
validated address, TLS hostname verification remains enabled, redirects are not followed,
and DNS, request duration and response size are bounded.

## State and delivery

SQLite runs with WAL and full synchronous commits. Callback credentials are encrypted with
AES-256-GCM and bound to the subscription ID as associated data. Replay cursors are
integrity-protected and bound to that same identity. Keep the storage key with backups.

One delivery worker preserves ordering within each subscription. Acknowledgement advances
the cursor; an unacknowledged matching event blocks following delivery. HTTP 408/429/5xx
and network failures retry exponentially, at most eight times, capped at five minutes
between attempts. Other errors stop automatic retry; 410 marks the subscription gone.
413 leaves the event retained but blocks delivery. Refresh can restore an active
subscription and resume its saved position.

Revision checks prevent in-flight delivery from overwriting an unsubscribe or refresh.
Key rotation signs with old and new secrets for one minute. Authorization and source
availability are rechecked before delivery. Acknowledgement means receipt, not task completion.

Maintenance removes an expired prefix of retained notifications, preserving monotonic
sequence numbers and recording the pruning boundary. Subscription replay responses report
`truncated: true` when requested history has been removed. Default retention is 30 days.
An hourly online backup is integrity checked; seven snapshots are kept in the data volume.
A backup failure degrades readiness. These local snapshots are not an off-host disaster
recovery strategy.

## Deliberate scope

There is one process and one container. Authentication supports the deployment already
validated with ChatGPT: Cloudflare Access Managed OAuth; loopback-only development tokens
are separate and forbidden in production. No custom OAuth server, provider API polling,
plugin archive, UI, remediation tools or dynamic integration-loading framework is included.
New integrations require code, validation and a release.
