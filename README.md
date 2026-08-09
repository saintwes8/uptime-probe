# uptime-probe

Scheduled external probe of a service's deep-health endpoint (URL held in the
`PROBE_URL` Actions secret). A failed run **is** the alert — GitHub notifies
the workflow author by email and mobile push on failure.

- `probe.yml` — every 10 minutes; 2 attempts 60s apart; requires HTTP 200 and
  `"ok":true` in the body.
- `keepalive.yml` — monthly heartbeat commit so GitHub never auto-disables the
  schedule (60-day inactivity rule for public repos).

Deliberate failure test: run `probe.yml` manually with `force_fail=true` and
confirm the failure notification arrives. Negative control: run it manually
with defaults and confirm no notification.

This repo gates nothing and is not part of any deploy pipeline.
