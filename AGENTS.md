# chatgpt-alerts

A self-hosted alert receiver and MCP Events server. Grafana is the first integration.

- Keep integrations behind their own adapters; core storage, events and tools use the normalized alert model.
- Keep deployment-specific hostnames, identities, networks, secrets and installation evidence outside this public repository.
- Use English, descriptive names and Conventional Commits. Add comments only for non-obvious constraints.
- Use the official MCP SDK for transport and ordinary tools. Preserve the supported ChatGPT MCP Events contract.
- Do not add a separate plugin package or UI unless explicitly requested. ChatGPT connects directly to the MCP endpoint.
- Image pipelines validate, build and publish only. Installation and updates are manual operator actions.
- Never weaken authentication, source authorization, webhook signatures, callback HTTPS/address checks, DNS pinning or encrypted secret storage.
- Verify behavior with `npm run check` and the Docker smoke check before releases. Cover security, persistence, subscription lifecycle and actual transport behavior.
- Webhook acknowledgement proves receipt, not completed ChatGPT work. Do not implement polling as a substitute for Events.
