#!/usr/bin/env bash
# Sculpin Hub PreToolUse guard. Reads a JSON tool-call event on stdin and blocks
# dangerous operations by exiting non-zero with a reason on stderr.
# Fail-open on parse errors is deliberate for non-security ergonomics, EXCEPT we
# always block the hard rules below.
set -euo pipefail

INPUT="$(cat)"

# Extract fields without requiring jq (fallback to grep). Prefer jq if present.
if command -v jq >/dev/null 2>&1; then
  TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
  FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')"
  CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"
  CONTENT="$(printf '%s' "$INPUT" | jq -r '.tool_input.content // empty')"
else
  TOOL="$(printf '%s' "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//')"
  FILE_PATH="$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//')"
  CMD="$(printf '%s' "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//')"
  CONTENT=""
fi

deny() { echo "BLOCKED by Sculpin Hub guard: $1" >&2; exit 2; }

SCULPIN_RO="/home/thomas/project/semanticmatter/sculpin"

# 1) Never write to the read-only Sculpin upstream.
case "$FILE_PATH" in
  "$SCULPIN_RO"|"$SCULPIN_RO"/*) deny "the Sculpin upstream ($SCULPIN_RO) is READ-ONLY" ;;
esac

# 2) Never edit generated Prisma client output.
case "$FILE_PATH" in
  */packages/db/generated/*) deny "packages/db/generated is generated Prisma output; run prisma generate instead" ;;
esac

# 3) Never write real .env / credential files (allow .env.example and .env.*.example).
BASENAME="${FILE_PATH##*/}"
case "$BASENAME" in
  .env|.env.local|.env.*.local) deny "refusing to write a real env/credential file ($BASENAME); use .env.example" ;;
  .env.*) case "$BASENAME" in *.example) : ;; *) deny "refusing to write a real env file ($BASENAME); use .env.example" ;; esac ;;
  credentials.json|*.pem|*.key|id_rsa|id_ed25519|serviceaccount.json) deny "refusing to write a credential file ($BASENAME)" ;;
esac

# 4) Block obvious committed secrets in written content.
if [ -n "$CONTENT" ]; then
  if printf '%s' "$CONTENT" | grep -Eq '(sk-exodus-[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,})'; then
    deny "written content appears to contain a hardcoded secret (API key / private key)"
  fi
fi

# 5) Block destructive git and writes to the Sculpin repo via bash.
if [ -n "$CMD" ]; then
  if printf '%s' "$CMD" | grep -Eq 'git[[:space:]].*(reset[[:space:]]+--hard|clean[[:space:]]+-[a-z]*f[a-z]*d|clean[[:space:]]+-[a-z]*d[a-z]*f|push[[:space:]].*--force|push[[:space:]].*-f($|[[:space:]]))'; then
    deny "destructive git command (reset --hard / clean -fd / push --force) is not allowed without explicit user approval"
  fi
  if printf '%s' "$CMD" | grep -Eq "(>|>>|tee|rm|mv|cp|mkdir|touch|sed[[:space:]]+-i)[^|;&]*$SCULPIN_RO"; then
    deny "attempt to modify the read-only Sculpin upstream ($SCULPIN_RO)"
  fi
fi

exit 0
