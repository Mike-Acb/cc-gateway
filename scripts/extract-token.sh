#!/bin/bash
# Extract tokens needed by CC Gateway from this machine.
#
# Usage:
#   bash scripts/extract-token.sh            # print both if available
#   bash scripts/extract-token.sh bearer     # print OAuth access_token as upstream Bearer token
#   bash scripts/extract-token.sh oauth      # print OAuth refresh_token for oauth_refresh mode
#   bash scripts/extract-token.sh both

set -euo pipefail

MODE="${1:-both}"

mask_token() {
  local token="$1"
  printf '%s...%s' "${token:0:20}" "${token: -6}"
}

load_oauth_creds() {
  local cred_file="$HOME/.claude/.credentials.json"
  if [[ -f "$cred_file" ]]; then
    echo "Source: ~/.claude/.credentials.json" >&2
    cat "$cred_file"
    return 0
  fi

  local creds=""
  creds=$(security find-generic-password -a "$USER" -s "Claude Code-credentials" -w 2>/dev/null || true)
  if [[ -n "$creds" ]]; then
    echo "Source: macOS Keychain" >&2
    printf '%s' "$creds"
    return 0
  fi

  echo "Error: No Claude Code OAuth credentials found." >&2
  echo "" >&2
  echo "Make sure you have logged into Claude Code on this machine:" >&2
  echo "  1. Run: claude" >&2
  echo "  2. Complete the browser OAuth login" >&2
  echo "  3. Then run this script again" >&2
  return 1
}

extract_oauth_field() {
  local field="$1"
  local creds="$2"
  printf '%s' "$creds" | python3 -c "import json,sys; raw=json.load(sys.stdin); claude=raw.get('claudeAiOauth') or {}; print(claude.get(sys.argv[1],''), end='')" "$field"
}

print_bearer() {
  echo "=== Upstream Bearer Token ==="
  echo ""

  local creds
  creds=$(load_oauth_creds) || return 1

  local access_token
  access_token=$(extract_oauth_field accessToken "$creds")
  if [[ -z "$access_token" ]]; then
    echo "Error: Could not extract accessToken from credentials."
    return 1
  fi

  echo "Bearer token found: $(mask_token "$access_token")"
  echo ""
  echo "Add this to your gateway config.yaml:"
  echo ""
  echo "upstream_auth:"
  echo "  mode: static_bearer"
  echo "  bearer_token: \"$access_token\""
}

print_oauth() {
  echo "=== Claude Code OAuth Refresh Token ==="
  echo ""

  local creds
  creds=$(load_oauth_creds) || return 1

  local refresh_token
  refresh_token=$(extract_oauth_field refreshToken "$creds")
  if [[ -z "$refresh_token" ]]; then
    echo "Error: Could not extract refreshToken from credentials."
    return 1
  fi

  echo "Refresh token found: $(mask_token "$refresh_token")"
  echo ""
  echo "Add this to your gateway config.yaml:"
  echo ""
  echo "oauth:"
  echo "  refresh_token: \"$refresh_token\""
}

case "$MODE" in
  bearer)
    print_bearer
    ;;
  oauth)
    print_oauth
    ;;
  both)
    bearer_ok=0
    oauth_ok=0
    print_bearer || bearer_ok=$?
    echo ""
    print_oauth || oauth_ok=$?
    if [[ $bearer_ok -ne 0 && $oauth_ok -ne 0 ]]; then
      exit 1
    fi
    ;;
  *)
    echo "Usage: bash scripts/extract-token.sh [bearer|oauth|both]"
    exit 1
    ;;
esac
