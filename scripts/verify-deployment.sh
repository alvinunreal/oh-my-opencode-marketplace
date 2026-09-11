#!/usr/bin/env bash
set -euo pipefail

readonly BASE_URL='https://registry.ohmyopencodeslim.com/v1'
readonly CACHE_BUST="${DEPLOY_SMOKE_CACHE_BUST:-${GITHUB_SHA:-local}-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}}"
readonly TEMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEMP_DIR"' EXIT

fetch_exact() {
  local url="$1"
  local body="$2"
  local headers="$3"
  local status

  status="$(curl --silent --show-error --globoff \
    --header 'Cache-Control: no-cache' \
    --dump-header "$headers" \
    --output "$body" \
    --write-out '%{http_code}' \
    "$url")"
  if [[ "$status" != '200' ]]; then
    printf 'Expected HTTP 200 from %s, received %s\n' "$url" "$status" >&2
    return 1
  fi
}

readonly INDEX_BODY="$TEMP_DIR/index.json"
readonly INDEX_HEADERS="$TEMP_DIR/index.headers"
readonly ARTIFACT_LIST="$TEMP_DIR/artifacts.txt"
fetch_exact "$BASE_URL/index.json?cache_bust=$CACHE_BUST" "$INDEX_BODY" "$INDEX_HEADERS"
cmp -- "$INDEX_BODY" 'dist/v1/index.json'
grep -Fqi -- \
  'cache-control: public, max-age=60, s-maxage=60, must-revalidate' \
  "$INDEX_HEADERS"

jq -er '.entries[] | .artifactPath | strings' -- dist/v1/index.json \
  > "$ARTIFACT_LIST"

while IFS= read -r artifact; do
  [[ -n "$artifact" ]] || continue
  local_artifact="dist/v1/$artifact"
  remote_artifact="$TEMP_DIR/$(basename -- "$artifact")"
  artifact_headers="$TEMP_DIR/$(basename -- "$artifact").headers"
  [[ -f "$local_artifact" ]] || {
    printf 'Missing local generated artifact %s\n' "$local_artifact" >&2
    exit 1
  }
  fetch_exact "$BASE_URL/$artifact?cache_bust=$CACHE_BUST" \
    "$remote_artifact" "$artifact_headers"
  cmp -- "$remote_artifact" "$local_artifact"
  grep -Fqi -- \
    'cache-control: public, max-age=31536000, immutable' \
    "$artifact_headers"
done < "$ARTIFACT_LIST"
