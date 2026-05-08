#!/bin/bash
set -e

# Run from tests/e2e directory or adjust paths
cd "$(dirname "$0")"

echo "🧪 Starting E2E combinations test..."

run_tests() {
  local desc="$1"
  local env_vars="$2"

  # Dev Mode
  echo "------------------------------------------------"
  echo "👉 [Dev] $desc"
  eval "$env_vars npm exec -- playwright test"

  # Preview Mode
  echo "------------------------------------------------"
  echo "👉 [Preview] $desc"
  # Pass E2E_PREVIEW=1 explicitly to ensure consistency
  eval "E2E_PREVIEW=1 $env_vars npm exec -- playwright test --config playwright.preview.config.ts"
}

# 1. Default (mine.localhost)
# Preview for default (mine.localhost) is skipped due to potential DNS resolution issues with deep subdomains on some environments.
# Covered by baseDomain=localhost test.
echo "------------------------------------------------"
echo "👉 [Dev] Default (mine.localhost)"
npm exec -- playwright test

# 2. Localhost base domain
run_tests "baseDomain=localhost" "E2E_BASE_DOMAIN=localhost"

# 3. localtest.me
run_tests "loopbackDomain=localtest.me" "E2E_LOOPBACK_DOMAIN=localtest.me"

# 4. lvh.me
run_tests "loopbackDomain=lvh.me" "E2E_LOOPBACK_DOMAIN=lvh.me"

# 5. nip.io
run_tests "loopbackDomain=nip.io" "E2E_LOOPBACK_DOMAIN=nip.io"

# 6. Explicit domain
echo "------------------------------------------------"
echo "👉 [Dev] Explicit domain"
E2E_DOMAIN=explicit.localtest.me npm exec -- playwright test

echo "------------------------------------------------"
echo "👉 [Preview] Explicit domain"
E2E_DOMAIN=explicit-preview.localtest.me npm exec -- playwright test --config playwright.preview.config.ts

echo "------------------------------------------------"
echo "✅ All combinations passed!"
