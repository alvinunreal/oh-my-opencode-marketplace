#!/usr/bin/env bash
set -euo pipefail

readonly BASE_URL='https://registry.ohmyopencodeslim.com'
readonly VERSIONS=('v1' 'v2')
readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CACHE_BUST="${DEPLOY_SMOKE_CACHE_BUST:?DEPLOY_SMOKE_CACHE_BUST must be set to a unique deployment probe value}"
readonly TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_DIR"' EXIT

fetch_exact() {
  local path="$1"
  local body="$2"
  local headers="$3"
  local status

  status="$(curl --silent --show-error --globoff \
    --header 'Cache-Control: no-cache' \
    --dump-header "$headers" \
    --output "$body" \
    --write-out '%{http_code}' \
    --get --data-urlencode "cache_bust=$CACHE_BUST" \
    "$BASE_URL$path")"
  if [[ "$status" != '200' ]]; then
    printf \
      'Expected HTTP 200 from %s with cache_bust=%s, received %s\n' \
      "$BASE_URL$path" "$CACHE_BUST" "$status" >&2
    printf \
      'No retry performed: a 404 can mean the custom domain or asset rollout still serves an older deployment.\n' \
      >&2
    return 1
  fi
}

for version in "${VERSIONS[@]}"; do
  index_body="$TEMP_DIR/$version-index.json"
  index_headers="$TEMP_DIR/$version-index.headers"
  artifact_list="$TEMP_DIR/$version-artifacts.txt"
  fetch_exact "/$version/index.json" \
    "$index_body" "$index_headers"
  cmp -- "$index_body" "$ROOT_DIR/dist/$version/index.json"
  grep -Fqi -- \
    'cache-control: public, max-age=60, s-maxage=60, must-revalidate' \
    "$index_headers"

  jq -er '.entries[] | .artifactPath | strings' -- "$ROOT_DIR/dist/$version/index.json" \
    > "$artifact_list"

  while IFS= read -r artifact; do
    [[ -n "$artifact" ]] || continue
    local_artifact="$ROOT_DIR/dist/$version/$artifact"
    remote_artifact="$TEMP_DIR/$version-$(basename -- "$artifact")"
    artifact_headers="$TEMP_DIR/$version-$(basename -- "$artifact").headers"
    [[ -f "$local_artifact" ]] || {
      printf 'Missing local generated artifact %s\n' "$local_artifact" >&2
      exit 1
    }
    fetch_exact "/$version/$artifact" \
      "$remote_artifact" "$artifact_headers"
    cmp -- "$remote_artifact" "$local_artifact"
    grep -Fqi -- \
      'cache-control: public, max-age=31536000, immutable' \
      "$artifact_headers"
  done < "$artifact_list"
done
