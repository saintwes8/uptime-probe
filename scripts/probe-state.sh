#!/usr/bin/env bash
# probe-state.sh — an alarm that speaks once when a condition starts and once when it clears.
#
# usage: probe-state.sh "<issue title>" red|green [detail-file]
#
# WHY. A scheduled probe whose failed run IS the alert mails the same fact on
# every run of a persistent condition: the acquisition probe sent 64 mails and
# the deep-health probe 68 between 2026-09-14 and 09-24 for one unchanged
# state (/health/deep 503 because the store reviewer's recorder was switched
# off), and the recipient stopped reading them — the exact failure this
# project files against other people's alarms. An alarm nobody reads is worse
# than no alarm, because it looks covered.
#
# HOW. The state lives in ONE open GitHub issue per condition, labelled
# `probe`, keyed on its exact title. red + no open issue => create it (that is
# the mail). red + open issue => say nothing. green + open issue => close it
# with a comment (the second and last mail). green + nothing open => silence.
# The workflow itself never fails on a schedule, so GitHub's per-run failure
# mail never fires; a workflow_dispatch run still reports the verdict as its
# result so a human pressing the button sees red.
set -euo pipefail
TITLE="${1:?title}"; VERDICT="${2:?red|green}"; DETAIL="${3:-/dev/null}"
LABEL="probe"
gh label create "$LABEL" --description "Probe state: one open issue per red condition" --color B60205 --force >/dev/null 2>&1 || true
open_no="$(gh issue list --state open --label "$LABEL" --limit 50 --json number,title --jq ".[] | select(.title == \"$TITLE\") | .number" | head -n1 || true)"
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
case "$VERDICT" in
  red)
    if [ -z "$open_no" ]; then
      tail_out="$(tail -n 40 "$DETAIL" 2>/dev/null || true)"
      body="$(printf 'Condition started %s (UTC).\n\nLast probe output:\n\n```\n%s\n```\n\nThis issue is the alert. It closes itself when the probe reads green again, and nothing else is mailed until then.\nRun: %s' "$now" "$tail_out" "${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}")"
      gh issue create --title "$TITLE" --label "$LABEL" --body "$body" >/dev/null
      echo "ALERT OPENED at $now: $TITLE"
    else
      echo "still red; issue #$open_no already open; no mail"
    fi ;;
  green)
    if [ -n "$open_no" ]; then
      gh issue close "$open_no" --comment "Cleared $now (UTC): the probe reads green again." >/dev/null
      echo "ALERT CLEARED at $now: $TITLE (#$open_no)"
    else
      echo "green; nothing open"
    fi ;;
  *) echo "verdict must be red or green, got '$VERDICT'" >&2; exit 2 ;;
esac
