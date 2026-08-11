#!/usr/bin/env bash
set -euo pipefail
: "${1:?central URL required}"
: "${2:?helper ID required}"
: "${3:?helper token required}"
export STUDIO_CENTRAL_URL="$1"
export STUDIO_HELPER_ID="$2"
export STUDIO_HELPER_TOKEN="$3"
npm run team:helper
