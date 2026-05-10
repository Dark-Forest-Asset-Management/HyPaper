#!/bin/bash
# HyPaper production deploy.
#
# Pulls the chosen branch on the deploy host, rebuilds, restarts the
# hypaper systemd service, and tails boot logs to verify it came up.
#
# All host/user/path/branch/service values are prompted with sensible
# defaults — no operator-specific or downstream-app values are baked
# into the script. Set env vars to skip the prompts in CI:
#
#   DEPLOY_SSH=user@host        SSH target
#   DEPLOY_PATH=~/HyPaper       Remote install path
#   DEPLOY_BRANCH=...           Branch to deploy (defaults to local
#                               current branch)
#   DEPLOY_SERVICE=hypaper      systemd service name
#
# Per the HyPaper README:
#   - Deploys via git pull on the server (NOT rsync — would clobber
#     node_modules / .env on the remote).
#   - Build runs on the server (`npm run build`).
#   - systemd service must be restarted after the build.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_BRANCH="$(cd "$REPO_ROOT" && git branch --show-current)"

if [[ -z "$DEFAULT_BRANCH" ]]; then
  echo "Could not detect current branch in $REPO_ROOT — exiting."
  exit 1
fi

prompt() {
  # prompt VAR_NAME "Question" "default"
  local __resultvar=$1 __question=$2 __default=$3 __input
  if [[ -n "${!__resultvar:-}" ]]; then return; fi
  if [[ -n "$__default" ]]; then
    read -r -p "${__question} [${__default}]: " __input
    __input="${__input:-$__default}"
  else
    read -r -p "${__question}: " __input
  fi
  printf -v "$__resultvar" '%s' "$__input"
}

prompt DEPLOY_SSH     "SSH target (user@host)" ""
prompt DEPLOY_PATH    "Remote install path"    "~/HyPaper"
prompt DEPLOY_BRANCH  "Branch to deploy"       "$DEFAULT_BRANCH"
prompt DEPLOY_SERVICE "systemd service name"   "hypaper"

if [[ -z "$DEPLOY_SSH" ]]; then
  echo "SSH target is required — exiting."
  exit 1
fi

echo
echo "Deploy plan:"
echo "  ssh:     ${DEPLOY_SSH}"
echo "  path:    ${DEPLOY_PATH}"
echo "  branch:  ${DEPLOY_BRANCH}"
echo "  service: ${DEPLOY_SERVICE}"
echo

# The remote command runs as a single ssh-quoted string. Shell expansion
# of DEPLOY_PATH / DEPLOY_BRANCH / DEPLOY_SERVICE happens locally before
# the string is sent (those values are interpolated into the string).
# Anything that should expand on the REMOTE side is escaped (\$).
ssh "$DEPLOY_SSH" "
  set -e
  cd ${DEPLOY_PATH}
  echo 'Branch on server:'
  git branch --show-current
  echo
  echo 'Fetching…'
  git fetch origin ${DEPLOY_BRANCH} 2>&1 | tail -3
  git checkout ${DEPLOY_BRANCH} 2>&1 | tail -3
  git pull --ff-only 2>&1 | tail -3
  echo \"HEAD: \$(git rev-parse --short HEAD) (\$(git log -1 --format=%s | head -c 60))\"
  echo
  echo 'Install dependencies…'
  # --include=dev so devDeps (typescript, tsx, drizzle-kit) are
  # present for the build + migrate steps below. ci is preferred
  # over install to honour package-lock exactly.
  npm ci --include=dev 2>&1 | tail -5
  echo
  echo 'Rebuild…'
  # PIPESTATUS to surface tsc's exit code despite the tail filter.
  # Without this, build failures get masked by tail's exit 0 and
  # the script happily restarts the service on stale dist.
  npm run build 2>&1 | tail -10
  if [ \"\${PIPESTATUS[0]}\" -ne 0 ]; then
    echo 'BUILD FAILED — aborting before migrate/restart' >&2
    exit 1
  fi
  echo
  echo 'DB migrations…'
  # Apply any pending drizzle migrations BEFORE restarting the service
  # so the running process never sees a schema older than its code.
  # db:migrate is idempotent — drizzle tracks applied migrations in
  # __drizzle_migrations and skips ones already on file. No-op when
  # there are no pending changes.
  # NB: avoid backticks inside this double-quoted ssh string — bash
  # treats them as local command substitution even on lines that
  # start with #, since # is not a comment marker inside a string.
  npm run db:migrate 2>&1 | tail -10
  echo
  echo 'Restart…'
  sudo systemctl restart ${DEPLOY_SERVICE}
  sleep 3
  sudo systemctl is-active ${DEPLOY_SERVICE}
  echo
  echo 'Boot logs (last 15 matching lines):'
  sudo journalctl -u ${DEPLOY_SERVICE} -n 50 --no-pager 2>&1 \
    | grep -iE 'schema verified|seeded|connected|listening|sub-dex|perpdex|error' \
    | tail -15
"

echo
echo "Done. Verify the API endpoint exposed on '${DEPLOY_SSH}' is responding."
