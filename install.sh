#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The Kodela Authors
#
# Kodela one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/tkarlmarx/kodela-oss/main/install.sh | sh
#
# Wraps the published npm package: it verifies Node is present, then runs
# `kodela setup` (guided onboarding) in the current directory via npx — no clone,
# no build. Set KODELA_ACTION=connect to wire every installed AI tool instead,
# or pass an explicit action as the first argument: `... | sh -s -- connect`.
#
# POSIX sh, no bashisms, so it runs under dash/ash as well.

set -eu

ACTION="${1:-${KODELA_ACTION:-setup}}"
PKG="@kodela/cli"
MIN_NODE_MAJOR=22

info() { printf '\033[36m›\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
err()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

# ── 1. Node check ────────────────────────────────────────────────────────────
if ! have node; then
  err "Node.js is required but was not found on your PATH."
  err "Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org (or via nvm) and re-run this installer."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  err "Node ${MIN_NODE_MAJOR}+ is required; found $(node -v)."
  err "Upgrade Node and re-run this installer."
  exit 1
fi
ok "Node $(node -v) detected."

if ! have npx; then
  err "npx was not found (it ships with npm). Install/upgrade npm and re-run."
  exit 1
fi

# ── 2. Pick the action ───────────────────────────────────────────────────────
case "$ACTION" in
  setup)   ARGS="setup --yes" ;;
  connect) ARGS="connect --apply --npx" ;;
  *)
    err "Unknown action '$ACTION'. Use 'setup' (default) or 'connect'."
    exit 1
    ;;
esac

# ── 3. Run it via npx (fetches @kodela/cli on first use) ─────────────────────
info "Running: npx -y ${PKG} ${ARGS}"
info "(in $(pwd))"
# shellcheck disable=SC2086
npx -y "${PKG}" ${ARGS}

ok "Kodela is set up."
info "Next: open your AI tool and start coding — Kodela captures the *why* as you go."
info "Docs: https://github.com/tkarlmarx/kodela-oss#readme"
