#!/usr/bin/env bash
set -euo pipefail
operator_env="${1:?Usage: release.sh /absolute/operator.env ghcr.io/owner/image@sha256:digest}"
release_image="${2:?An immutable image digest is required}"
[[ "$operator_env" = /* && -f "$operator_env" ]] || { echo 'Operator environment must be an existing absolute path' >&2; exit 1; }
[[ "$release_image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Expected an immutable GHCR digest' >&2; exit 1; }
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose=(docker compose --env-file "$operator_env" -f "$repo_dir/deploy/compose.yaml")
previous_image="$(docker inspect -f '{{.Config.Image}}' chatgpt-alerts-server-1 2>/dev/null || true)"
IMAGE_DIGEST="$release_image" "${compose[@]}" config --quiet
docker pull "$release_image"
if ! IMAGE_DIGEST="$release_image" "${compose[@]}" up -d --wait --wait-timeout 90; then
  if [ -n "$previous_image" ]; then
    echo 'Health failed; restoring the previous image' >&2
    IMAGE_DIGEST="$previous_image" "${compose[@]}" up -d --wait --wait-timeout 90
  fi
  exit 1
fi
temporary_env="$(mktemp "${operator_env}.XXXXXX")"
trap 'rm -f "$temporary_env"' EXIT
awk '!/^IMAGE_DIGEST=/' "$operator_env" > "$temporary_env"
printf '\nIMAGE_DIGEST=%s\n' "$release_image" >> "$temporary_env"
chmod 0600 "$temporary_env"
chown --reference="$operator_env" "$temporary_env"
mv -f "$temporary_env" "$operator_env"
trap - EXIT
printf 'Healthy: %s\n' "$release_image"
