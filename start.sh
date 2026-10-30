#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Node.js and npm are required to run the desktop development app.\n' >&2
  exit 1
fi

if [[ ! -f "$PROJECT_ROOT/node_modules/vite/bin/vite.js" || \
  ! -f "$PROJECT_ROOT/desktop/electron/node_modules/electron/cli.js" ]]; then
  printf 'Project dependencies are missing. Install the root and Electron dependencies first.\n' >&2
  printf '  npm install\n  npm --prefix desktop/electron --workspaces=false install\n' >&2
  exit 1
fi

START_BACKEND="${AGENT_PLATFORM_START_BACKEND:-1}"
if [[ "$START_BACKEND" == '1' ]]; then
  if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
    printf 'Missing .env for the local Docker backend. Create it first, or set AGENT_PLATFORM_START_BACKEND=0.\n' >&2
    exit 1
  fi

  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker is required for the local backend. Set AGENT_PLATFORM_START_BACKEND=0 to use an existing server.\n' >&2
    exit 1
  fi

  if docker compose version >/dev/null 2>&1; then
    docker compose up -d api meilisearch vectordb
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose up -d api meilisearch vectordb
  else
    printf 'Docker Compose is required for the local backend.\n' >&2
    exit 1
  fi
elif [[ "$START_BACKEND" != '0' ]]; then
  printf 'AGENT_PLATFORM_START_BACKEND must be 1 or 0.\n' >&2
  exit 1
fi

printf 'Starting the Agent Platform desktop development app. Press Ctrl-C to stop Vite and Electron.\n'
exec npm run desktop:dev
