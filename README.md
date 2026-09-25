# uptime-probe

Scheduled external probe of a service's deep-health endpoint (URL held in the
`PROBE_URL` Actions secret).

**The alert is one GitHub issue per red condition, not the run result**
(`scripts/probe-state.sh`, since 2026-09-24). A red verdict opens the issue
once; while it stays red nothing more is sent; when the probe reads green the
issue closes itself with a comment. Two mails per incident, start and clear.
Between 2026-09-14 and 09-24 the old "a failed run is the alert" design mailed
the same unchanged fact 132 times across two probes and stopped being read. A
scheduled run therefore never fails; a `workflow_dispatch` run still reports
the verdict as its result, so `force_fail=true` shows red to the person who
pressed it and opens the issue, which the next green run closes.

- `probe.yml` — every 10 minutes; 2 attempts 60s apart; requires HTTP 200 and
  `"ok":true` in the body.
- `probe.yml` `relay` job — same schedule, URL in the `RELAY_PROBE_URL`
  secret (the relay's `/health`). Three assertions: **liveness** (200 +
  `ok:true`, 2 attempts 60s apart); **capacity** (alert when `attachments` is
  at or above 80% of `maxAttachments` — the cap is a hard refusal, so this
  fires before it binds); **churn** (`attachmentsReplacedTotal` sampled twice
  60s apart, alert at >=5, and alert if `uptimeSec` goes backwards). It does
  NOT alert on low attachment level: zero is a normal recorder-off night.
  Drill: point `RELAY_PROBE_URL` at a dead port, dispatch, confirm the failure
  notification, point it back.
- `main-red.yml` — hourly; alerts when `saintwes8/airdvr-backend`'s `main` has
  been RED for more than 60 minutes, and **also when it cannot tell**: no runs,
  no completed runs, only cancellations, a malformed payload, a missing or
  rejected credential, or a latest verdict older than 14 days (the Suite may
  have been deleted or unhooked). There is no path out of it that reads clean
  without having positively seen a recent green. `probe.yml` asks whether the
  service answers; this asks whether the pipeline is still delivering, which a
  service serving last week's code answers "yes" to.
  - Verdict logic: `scripts/main-red.mjs`. Drill: `node test/drill.mjs`
    (offline, deterministic, 23 cases including both stuck-function controls).
    The workflow runs the drill before every check.
  - **Needs `BACKEND_ACTIONS_TOKEN`**: airdvr-backend is private, so this
    repo's `GITHUB_TOKEN` cannot read it. A fine-grained PAT scoped to
    `saintwes8/airdvr-backend`, `Actions: Read-only`, nothing else. Until it is
    set, every run fails saying exactly that — by design.
- `keepalive.yml` — monthly heartbeat commit so GitHub never auto-disables the
  schedule (60-day inactivity rule for public repos). It keeps BOTH scheduled
  workflows above alive.

Deliberate failure test: run `probe.yml` or `main-red.yml` manually with
`force_fail=true` and confirm the failure notification arrives. Negative
control: run it manually with defaults and confirm no notification.

This repo gates nothing and is not part of any deploy pipeline.
