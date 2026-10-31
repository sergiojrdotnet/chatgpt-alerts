# Deployment

## Prepare the instance

Use a stable HTTPS origin protected by a Cloudflare Access MCP application with Managed
OAuth, dynamic client registration and a policy for the intended users. Allow the current
ChatGPT OAuth redirect URLs advertised by its connection flow. Inspect the provider's
OAuth metadata rather than guessing authorization or token endpoints.

Expose `/mcp` and the provider-managed OAuth discovery paths through a Cloudflare Tunnel.
Require Access validation at the tunnel and at the application. Keep webhook and health
routes private; only Grafana needs the webhook address on the shared Docker network.
The MCP Portal is not required for the direct connection or host event subscriptions.

Install a checked-out release under an operator-owned directory. Copy the example
`server.env`, `sources.json` and `operator.env` from `deploy/` into a private configuration
directory outside the checkout. Fill the real Access domain/audience, allowed emails,
HTTPS origin and source secrets. Generate a stable storage key with `openssl rand -base64 32`.
The server environment and operator environment should be readable only by the operator.
The mounted sources JSON must be readable by container UID 1000; use owner 1000 and mode
0600, with its parent directory private to the operator.

Set `ALERTS_NETWORK` to an existing Docker network shared with Grafana, and select an
unused loopback `MCP_PORT`. Grafana addresses the `chatgpt-alerts` network alias directly;
Cloudflare Tunnel addresses the loopback port. Never publish the webhook on the internet.

## Install or update manually

The GitHub release workflow validates and publishes an immutable container image only.
It never connects to the VPS. Confirm the release checks and image digest, then run:

```sh
./deploy/release.sh /absolute/path/to/operator.env ghcr.io/sergiojrdotnet/chatgpt-alerts@sha256:THE_VERIFIED_DIGEST
```

The script pulls the exact digest, validates Compose and waits for readiness. It records
the new digest only after the container is healthy. If health fails and a previous image
exists, it attempts to restore that image and verifies recovery. Read release notes before
upgrades: an image rollback does not roll database changes or operator configuration back.

Confirm only the intended source integration is reachable, forged MCP assertions fail,
Grafana's signed integration test succeeds, and host-created firing/resolved subscriptions
receive events. Check the resulting ChatGPT response separately. Monitor service health,
callback errors, source freshness, container restarts and backup readiness after deployment.

## Data and recovery

The named volume stores `alerts.sqlite`, its WAL and seven hourly backups under `backups/`.
Keep `STORAGE_KEY` in the same protected recovery plan. Copy a verified snapshot off-host;
local snapshots cannot survive volume or VPS loss. For restoration, stop the service,
restore one snapshot as `alerts.sqlite` into a clean data directory with UID 1000 ownership,
keep the matching storage key and restart. Do not copy a live database file without its
WAL; use an online backup or stop the process first.

Stop monitoring in the host before removing an instance. Remove the corresponding
Grafana contact point/policy, Access application, dedicated DNS/Tunnel routes and operator
configuration. Shared networks, tunnels and unrelated integrations belong to their owners.
