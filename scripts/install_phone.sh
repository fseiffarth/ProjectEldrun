#!/usr/bin/env bash
set -euo pipefail

machine=false
if [[ "${1:-}" == "--url" ]]; then
  machine=true
elif [[ $# -ne 0 ]]; then
  echo "usage: $0 [--url]" >&2
  exit 2
fi

state_dir="${XDG_DATA_HOME:-$HOME/.local/share}/eldrun"
settings="$state_dir/settings.json"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v tailscale >/dev/null || { echo "Tailscale is not installed" >&2; exit 1; }
[[ -r "$settings" ]] || { echo "Eldrun settings are unavailable" >&2; exit 1; }

enabled="$(jq -r '.eldrun_mobile_host.enabled // false' "$settings")"
port="$(jq -r '.eldrun_mobile_host.port // 8742' "$settings")"
origin="$(jq -r '.eldrun_mobile_host.serve_origin // empty' "$settings")"
[[ "$enabled" == "true" ]] || { echo "Eldrun Mobile is disabled" >&2; exit 1; }
[[ "$origin" =~ ^https://([^/:]+)(:([0-9]+))?$ ]] || {
  echo "No verified exact HTTPS Serve origin is configured" >&2
  exit 1
}
serve_host="${BASH_REMATCH[1]}"
public_port="${BASH_REMATCH[3]:-443}"
authority="$serve_host:$public_port"

curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$port/healthz" | jq -e '.ok == true' >/dev/null
serve_json="$(tailscale serve status --json)"
needle="http://127.0.0.1:$port"
jq -e --arg authority "$authority" --arg needle "$needle" --arg public_port "$public_port" '
  .TCP[$public_port].HTTPS == true
  and .Web[$authority].Handlers["/"].Proxy == $needle
  and ((.AllowFunnel[$authority] // false) | not)
' <<<"$serve_json" >/dev/null || {
  echo "Tailscale Serve does not have the verified private root mapping to the configured loopback port" >&2
  exit 1
}
curl --fail --silent --show-error --max-time 5 "$origin/healthz" | jq -e '.ok == true' >/dev/null

if $machine; then
  printf '%s\n' "$origin"
  exit 0
fi

echo "Open this private URL on your phone:"
echo "$origin"
if command -v qrencode >/dev/null; then
  qrencode -t ANSIUTF8 "$origin"
else
  echo "Install qrencode to print a terminal QR code."
fi
echo "Then use Install app / Add to Home Screen and pair it from Eldrun Settings."
