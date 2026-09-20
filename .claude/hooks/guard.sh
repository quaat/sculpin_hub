#!/usr/bin/env bash
# Sculpin Hub PreToolUse guard. Reads a JSON tool-call event on stdin and blocks
# dangerous operations by exiting non-zero (code 2) with a reason on stderr.
#
# Security posture: FAIL-CLOSED for protected targets. If the structured
# tool_input cannot be parsed, the guard still scans the RAW event for protected
# markers and blocks rather than silently allowing a protected write or
# destructive command. The hard rules below never depend solely on successful
# field extraction.
set -uo pipefail

INPUT="$(cat)"

# Structured extraction for precise messages. Prefer jq; fall back to grep. When
# extraction fails the field is empty and the raw-input safety net applies.
if command -v jq >/dev/null 2>&1; then
  FILE_PATH="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
  CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
  CONTENT="$(printf '%s' "$INPUT" | jq -r '[.tool_input.content, .tool_input.new_string, .tool_input.old_string] | map(select(. != null)) | join("\n")' 2>/dev/null || true)"
else
  FILE_PATH="$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//')"
  CMD="$(printf '%s' "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//')"
  # Without jq we cannot reliably isolate content; the raw-input scan covers it.
  CONTENT=""
fi

deny() { echo "BLOCKED by Sculpin Hub guard: $1" >&2; exit 2; }
matches() { grep -Eq "$1"; }

SCULPIN_RO="/home/thomas/project/semanticmatter/sculpin"
# Boundary so the read-only "sculpin" tree is never confused with sibling paths
# such as "sculpin_hub" (this repo). A protected path ends at a slash, a quote,
# or whitespace, never an identifier char.
SCULPIN_BOUNDARY='(/|"|[[:space:]]|$)'

# ---------------------------------------------------------------------------
# 1) Never write to the read-only Sculpin upstream.
# ---------------------------------------------------------------------------
case "$FILE_PATH" in
  "$SCULPIN_RO"|"$SCULPIN_RO"/*) deny "the Sculpin upstream ($SCULPIN_RO) is READ-ONLY" ;;
esac
# Fail-closed: a Write/Edit whose file_path did not parse but whose raw event
# references the read-only tree in a file_path position is blocked.
if [ -z "$FILE_PATH" ] && [ -z "$CMD" ]; then
  if printf '%s' "$INPUT" | matches "\"file_path\"[[:space:]]*:[[:space:]]*\"${SCULPIN_RO}${SCULPIN_BOUNDARY}"; then
    deny "the Sculpin upstream ($SCULPIN_RO) is READ-ONLY (unparsed file_path)"
  fi
fi

# ---------------------------------------------------------------------------
# 2) Never edit generated Prisma client output.
# ---------------------------------------------------------------------------
case "$FILE_PATH" in
  */packages/db/generated/*) deny "packages/db/generated is generated Prisma output; run prisma generate instead" ;;
esac
if [ -z "$FILE_PATH" ] && [ -z "$CMD" ]; then
  if printf '%s' "$INPUT" | matches "\"file_path\"[[:space:]]*:[[:space:]]*\"[^\"]*packages/db/generated/"; then
    deny "packages/db/generated is generated Prisma output (unparsed file_path)"
  fi
fi

# ---------------------------------------------------------------------------
# 3) Never write real .env / credential files (allow *.example).
# ---------------------------------------------------------------------------
if [ -n "$FILE_PATH" ]; then
  BASENAME="${FILE_PATH##*/}"
  case "$BASENAME" in
    .env|.env.local|.env.*.local) deny "refusing to write a real env/credential file ($BASENAME); use .env.example" ;;
    .env.*) case "$BASENAME" in *.example) : ;; *) deny "refusing to write a real env file ($BASENAME); use .env.example" ;; esac ;;
    credentials.json|*.pem|*.key|id_rsa|id_ed25519|serviceaccount.json) deny "refusing to write a credential file ($BASENAME)" ;;
  esac
elif [ -z "$CMD" ]; then
  # Fail-closed: a Write/Edit whose file_path did not parse but that targets a
  # real .env file in the raw event is blocked.
  if printf '%s' "$INPUT" | matches "\"file_path\"[[:space:]]*:[[:space:]]*\"[^\"]*/\.env(\"|\.local|\.[^\"]*\.local)"; then
    deny "refusing to write a real env/credential file (unparsed file_path); use .env.example"
  fi
fi

# ---------------------------------------------------------------------------
# 4) Block obvious committed secrets. Scan extracted content for a precise
#    message, then scan the raw event unconditionally as a fail-closed net
#    (covers new_string without jq and malformed events).
# ---------------------------------------------------------------------------
SECRET_RE='(sk-exodus-[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{36}|gho_[0-9A-Za-z]{36})'
if [ -n "$CONTENT" ] && printf '%s' "$CONTENT" | matches "$SECRET_RE"; then
  deny "written content appears to contain a hardcoded secret (API key / private key)"
fi
if printf '%s' "$INPUT" | matches "$SECRET_RE"; then
  deny "event appears to contain a hardcoded secret (API key / private key)"
fi

# ---------------------------------------------------------------------------
# 5) Block destructive version-control commands and bash writes to the Sculpin
#    repo. These rules target BASH commands: prefer the parsed command, and only
#    fall back to the raw event when NOTHING structured parsed (a genuinely
#    malformed Bash event). For Write/Edit (FILE_PATH set) the file target was
#    already vetted in sections 1-3, so the raw JSON, which may contain
#    incidental redirection or verb substrings inside file contents or the
#    ambient cwd, must NOT be re-scanned as if it were a shell command.
# ---------------------------------------------------------------------------
DESTRUCTIVE_GIT_RE='git[[:space:]].*(reset[[:space:]]+--hard|clean[[:space:]]+-[a-z]*f[a-z]*d|clean[[:space:]]+-[a-z]*d[a-z]*f|push[[:space:]].*--force|push[[:space:]].*-f($|[[:space:]])|branch[[:space:]]+-D)'
SCULPIN_WRITE_RE="(>|>>|tee|rm|mv|cp|mkdir|touch|sed[[:space:]]+-i)[^|;&]*${SCULPIN_RO}${SCULPIN_BOUNDARY}"
GIT_HAYSTACK="$CMD"
if [ -z "$GIT_HAYSTACK" ] && [ -z "$FILE_PATH" ]; then
  GIT_HAYSTACK="$INPUT"
fi
if [ -n "$GIT_HAYSTACK" ]; then
  if printf '%s' "$GIT_HAYSTACK" | matches "$DESTRUCTIVE_GIT_RE"; then
    deny "destructive git command (hard reset / clean -fd / force push / branch delete) blocked without explicit user approval"
  fi
  if printf '%s' "$GIT_HAYSTACK" | matches "$SCULPIN_WRITE_RE"; then
    deny "attempt to modify the read-only Sculpin upstream ($SCULPIN_RO)"
  fi
fi

exit 0
