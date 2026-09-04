#!/usr/bin/env node
/**
 * main-red.mjs — HAS airdvr-backend's `main` BEEN RED FOR MORE THAN AN HOUR?
 *
 * WHY THIS EXISTS (row 158). `main` in airdvr-backend is the deploy branch:
 * Railway gates on the Suite's check run, so a red `main` is a production
 * deploy that silently is not happening. Nothing watched that. The one external
 * monitor in this repo watches the RUNNING service (`probe.yml`), and a service
 * that is up and serving last week's code looks identical to a healthy one from
 * outside. The blind spot is not "is the site down" — it is "has the pipeline
 * stopped delivering", and no request fails while that is true.
 *
 * WHY IT LIVES HERE AND NOT IN airdvr-backend. An alarm hosted inside the thing
 * it watches dies with it. airdvr-backend is a PRIVATE repo, so its Actions
 * minutes are billed, and a $0 Actions budget has already silently stopped
 * dispatches on this account once. Under that failure both CI and an in-repo
 * alarm stop together, and the alarm's silence is indistinguishable from
 * success. This repo is public, its minutes are free, and it is already the
 * agreed home for "watch from outside".
 *
 * ---------------------------------------------------------------------------
 * THE RULE. Exit 0 = quiet. Exit 1 = ALERT (the failed run IS the alert; GitHub
 * mails and pushes the workflow author).
 *
 * ALERT when:
 *   1. main's most recent VERDICT is red and finished more than RED_GRACE_MIN
 *      minutes ago;
 *   2. there is no verdict to read at all — no runs, no completed runs, none
 *      carrying a conclusion, an unparseable payload, or a payload of the wrong
 *      shape;
 *   3. the most recent verdict, whatever it says, is older than STALE_DAYS.
 *
 * (2) IS THE POINT OF THE WHOLE FILE. A check that reads "clean" when it could
 * not see its subject is worse than no check: it converts an outage into a
 * green tick. Every path out of this script that has not positively established
 * "main's latest verdict is a success, and it is recent" exits 1. There is no
 * default-quiet branch. The workflow around it does the same thing with a
 * missing credential, and the fetch is wrapped so that a 401, a 404, a rate
 * limit and a DNS failure all land in the same place.
 *
 * (3) IS THE ABSENCE THAT (2) CANNOT SEE. If the Suite workflow is deleted,
 * disabled, or simply stops being triggered, the last green run stands as
 * "main's latest verdict" forever, and rule (1) never fires because nothing is
 * red. The only signal left is the verdict's AGE. STALE_DAYS is deliberately
 * far past any quiet stretch this repo has — it is not a liveness check on
 * development, it is a backstop against the workflow silently ceasing to exist,
 * and it is honest about costing up to STALE_DAYS to notice.
 *
 * WHY "RED FOR AN HOUR" AND NOT "RED". A red main is normal for the minutes
 * between a bad push and its fix, and an alarm that fires on those is an alarm
 * that gets muted. An hour is long enough that the push-and-fix loop never
 * reaches it and short enough that a red main cannot sit through a night.
 * Measured from when the failing run FINISHED, not from when it started, so a
 * 20-minute run does not spend a third of its grace being slow.
 *
 * CANCELLED IS NOT A VERDICT. A cancelled, skipped or neutral run says nothing
 * about the code, so the scan walks past it to the most recent run that
 * actually concluded. It does NOT treat cancellation as success, and if the
 * whole window is cancellations there is no verdict and rule (2) fires.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 *   node scripts/main-red.mjs                 # fetch live, needs GH_TOKEN
 *   node scripts/main-red.mjs --file f.json   # judge a saved/synthetic payload
 *   cat f.json | node scripts/main-red.mjs -  # judge stdin
 *
 * The drills feed --file/- so the SAME verdict function that runs in production
 * is the one under test; only where the bytes come from differs.
 */

const OWNER = process.env.WATCH_OWNER || 'saintwes8';
const REPO = process.env.WATCH_REPO || 'airdvr-backend';
const BRANCH = process.env.WATCH_BRANCH || 'main';
const RED_GRACE_MIN = Number(process.env.RED_GRACE_MIN || 60);
const STALE_DAYS = Number(process.env.STALE_DAYS || 14);

// Conclusions that mean "the code was judged and found wanting".
const RED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
// Conclusions that mean "no judgement was reached" — walked past, never trusted.
const NO_VERDICT = new Set(['cancelled', 'skipped', 'neutral', 'stale', null, undefined]);

/** GitHub Actions' own annotation, so the reason is on the run's summary page. */
function ghError(msg) {
  console.log(`::error::${msg}`);
}

/**
 * The whole decision, as a pure function of a payload and a clock.
 *
 * Returns { alert: boolean, reason: string, detail: object }. Pure so the
 * drills can assert on it without a network or a wall clock, and so that
 * "what would it have said at time T" is answerable.
 */
export function judge(payload, nowMs) {
  const bad = (reason, detail = {}) => ({ alert: true, reason, detail });

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return bad('payload is not an object — nothing was read');
  }
  const runs = payload.workflow_runs;
  if (!Array.isArray(runs)) {
    // Includes GitHub's error bodies ({message, documentation_url}), which are
    // 200-shaped objects with no runs in them.
    return bad(
      `payload carries no workflow_runs array — nothing was read${
        typeof payload.message === 'string' ? ` (API said: ${payload.message})` : ''
      }`,
    );
  }
  if (runs.length === 0) {
    return bad(`no workflow runs at all on ${OWNER}/${REPO}@${BRANCH}`);
  }

  const completed = runs.filter((r) => r && r.status === 'completed');
  if (completed.length === 0) {
    return bad(`${runs.length} run(s) on ${BRANCH}, none completed — no verdict exists`);
  }

  // The API returns newest-created first; keep that order so "latest verdict"
  // means the newest COMMIT judged, not the most recently re-run old commit.
  const verdicts = completed.filter((r) => !NO_VERDICT.has(r.conclusion));
  if (verdicts.length === 0) {
    return bad(
      `${completed.length} completed run(s) on ${BRANCH}, every one cancelled or skipped — no verdict exists`,
    );
  }

  const latest = verdicts[0];
  const finishedMs = Date.parse(latest.updated_at ?? '');
  if (Number.isNaN(finishedMs)) {
    return bad(`latest verdict run #${latest.run_number} has an unreadable updated_at`, {
      updated_at: latest.updated_at,
    });
  }
  const ageMin = (nowMs - finishedMs) / 60000;
  const detail = {
    run: latest.run_number,
    sha: String(latest.head_sha ?? '').slice(0, 7),
    conclusion: latest.conclusion,
    finishedAt: latest.updated_at,
    ageMin: Math.round(ageMin),
    url: latest.html_url,
    title: latest.display_title,
  };

  if (ageMin > STALE_DAYS * 24 * 60) {
    return bad(
      `${BRANCH}'s latest verdict is ${Math.round(ageMin / 1440)} days old (> ${STALE_DAYS}d) — ` +
        'the Suite may have been deleted, disabled or unhooked, and a red would no longer be visible',
      detail,
    );
  }

  if (RED.has(latest.conclusion)) {
    if (ageMin > RED_GRACE_MIN) {
      return bad(
        `${OWNER}/${REPO}@${BRANCH} has been RED for ${Math.round(ageMin)} min ` +
          `(grace ${RED_GRACE_MIN} min) — run #${latest.run_number} ${latest.conclusion} on ${detail.sha}. ` +
          'Railway gates the deploy on this, so production is not receiving main.',
        detail,
      );
    }
    return {
      alert: false,
      reason:
        `${BRANCH} is red but only for ${Math.round(ageMin)} min — inside the ` +
        `${RED_GRACE_MIN} min grace, alerting in ${Math.round(RED_GRACE_MIN - ageMin)} min if unfixed`,
      detail,
    };
  }

  return {
    alert: false,
    reason: `${BRANCH} is ${latest.conclusion} (run #${latest.run_number}, ${Math.round(ageMin)} min ago)`,
    detail,
  };
}

async function fetchRuns() {
  const token = process.env.GH_TOKEN;
  if (!token) {
    // Not an exception: a missing credential is one of the ways this check goes
    // blind, and it must alert like every other one.
    return { fatal: 'GH_TOKEN is not set — the watcher has no credential and cannot read anything' };
  }
  const url =
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/runs` +
    `?branch=${encodeURIComponent(BRANCH)}&event=push&per_page=30`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'uptime-probe-main-red',
      },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { fatal: `request to api.github.com failed: ${e.message}` };
  }
  if (!res.ok) {
    // 401 expired token, 403 rate limit or revoked scope, 404 repo renamed or
    // the token no longer selects it. Every one is blindness, not health.
    return { fatal: `api.github.com returned HTTP ${res.status} — the watcher is blind, not clear` };
  }
  try {
    return { payload: await res.json() };
  } catch (e) {
    return { fatal: `api.github.com returned unparseable JSON: ${e.message}` };
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  let payload;

  if (args[0] === '--file' || args[0] === '-') {
    const { readFileSync } = await import('node:fs');
    const text = args[0] === '-' ? await readStdin() : readFileSync(args[1], 'utf8');
    try {
      payload = JSON.parse(text);
    } catch (e) {
      ghError(`ALERT: input is not JSON: ${e.message}`);
      process.exit(1);
    }
  } else {
    const got = await fetchRuns();
    if (got.fatal) {
      ghError(`ALERT: ${got.fatal}`);
      process.exit(1);
    }
    payload = got.payload;
  }

  const v = judge(payload, Date.now());
  const line = JSON.stringify(v.detail ?? {});
  if (v.alert) {
    ghError(`ALERT: ${v.reason}`);
    console.log(line);
    process.exit(1);
  }
  console.log(`quiet: ${v.reason}`);
  console.log(line);
  process.exit(0);
}

// Importable for the drills without running main().
if (process.argv[1] && process.argv[1].endsWith('main-red.mjs')) {
  main().catch((e) => {
    // Even an unforeseen throw must be loud. There is no path to exit 0 that
    // did not pass the verdict function.
    ghError(`ALERT: watcher threw before reaching a verdict: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  });
}
