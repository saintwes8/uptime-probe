#!/usr/bin/env node
/**
 * drill.mjs — proves main-red.mjs in BOTH directions, and proves that every way
 * it can go blind ends in an alert rather than in silence.
 *
 * Run: node test/drill.mjs
 *
 * The subject is `judge`, the same function the workflow's exit code comes
 * from. Nothing here reaches the network, so the drill runs on a machine with
 * no credential and gives the same answer every time — a clock is passed in
 * rather than read.
 *
 * THE FIXTURE SHAPE IS NOT INVENTED, AND IT IS NOT COMMITTED. It was taken from
 * a real response for saintwes8/airdvr-backend, and the same real response was
 * run through this script's --file path with its newest run flipped to
 * `failure` and back-dated, which is the both-directions drill on live data.
 * The captured payload is kept OUT of this repository on purpose: this repo is
 * public and that payload carries a private repository's commit titles, SHAs
 * and actor names.
 */
import assert from 'node:assert/strict';
import { judge } from '../scripts/main-red.mjs';

const NOW = Date.parse('2026-09-04T23:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();

const run = (o = {}) => ({
  run_number: 1,
  head_sha: 'abcdef1234567890',
  status: 'completed',
  conclusion: 'success',
  updated_at: ago(10),
  html_url: 'https://github.com/saintwes8/airdvr-backend/actions/runs/1',
  display_title: 'a commit',
  ...o,
});
const payload = (...runs) => ({ total_count: runs.length, workflow_runs: runs });

let pass = 0;
const cases = [];
function check(name, input, wantAlert, reasonRe) {
  cases.push(() => {
    const v = judge(input, NOW);
    assert.equal(
      v.alert,
      wantAlert,
      `${name}: expected alert=${wantAlert}, got ${v.alert} (${v.reason})`,
    );
    if (reasonRe) assert.match(v.reason, reasonRe, `${name}: reason was "${v.reason}"`);
    console.log(`  ok  ${wantAlert ? 'ALERT ' : 'quiet '} ${name}\n        -> ${v.reason}`);
    pass++;
  });
}

// ---------------------------------------------------------------- the two
// directions the alarm exists to distinguish. Identical payloads apart from
// the conclusion and the age, so it is those that decide and nothing else.
check('green main is quiet', payload(run()), false, /success/);
check(
  'RED for 61 min alerts',
  payload(run({ conclusion: 'failure', updated_at: ago(61) })),
  true,
  /RED for 61 min/,
);
check(
  'red for 59 min is inside the grace and stays quiet',
  payload(run({ conclusion: 'failure', updated_at: ago(59) })),
  false,
  /alerting in 1 min/,
);
check(
  'red for exactly 60 min is not yet over the grace',
  payload(run({ conclusion: 'failure', updated_at: ago(60) })),
  false,
  /inside the/,
);
// The push-and-fix loop: a red run followed by a green one on a newer commit.
check(
  'a fix landing after a 3h red silences it',
  payload(run({ run_number: 9, updated_at: ago(5) }), run({ run_number: 8, conclusion: 'failure', updated_at: ago(180) })),
  false,
  /success/,
);
// ...and the reverse order must NOT be read as fixed: newest first is the API's
// order, so a green that PRECEDED the red must not win.
check(
  'an older green does not clear a newer red',
  payload(run({ run_number: 9, conclusion: 'failure', updated_at: ago(200) }), run({ run_number: 8, updated_at: ago(400) })),
  true,
  /RED for 200 min/,
);

// ------------------------------------------------ other red-shaped verdicts
for (const c of ['timed_out', 'startup_failure', 'action_required']) {
  check(`${c} counts as red`, payload(run({ conclusion: c, updated_at: ago(120) })), true, /RED/);
}

// ------------------------------------------------------- MISSING MUST ALERT
check('empty run list alerts', payload(), true, /no workflow runs at all/);
check('no completed runs alerts', payload(run({ status: 'in_progress', conclusion: null })), true, /none completed/);
check(
  'all cancelled alerts — a cancel is not a pass',
  payload(run({ conclusion: 'cancelled' }), run({ conclusion: 'skipped' })),
  true,
  /every one cancelled or skipped/,
);
check(
  'a cancel is walked past to the real verdict beneath it',
  payload(run({ conclusion: 'cancelled', updated_at: ago(2) }), run({ conclusion: 'failure', updated_at: ago(300) })),
  true,
  /RED for 300 min/,
);
check('missing workflow_runs key alerts', { total_count: 0 }, true, /carries no workflow_runs/);
check(
  "GitHub's error body alerts and quotes it",
  { message: 'Bad credentials', documentation_url: 'https://docs.github.com' },
  true,
  /API said: Bad credentials/,
);
check('an array instead of an object alerts', [], true, /not an object/);
check('null alerts', null, true, /not an object/);
check('a string alerts', 'workflow_runs', true, /not an object/);
check(
  'an unreadable finish time alerts rather than being treated as now',
  payload(run({ updated_at: 'yesterday' })),
  true,
  /unreadable updated_at/,
);

// --------------------------------------------- the absence rule (2) cannot see
check(
  'a green verdict older than 14 days alerts — the Suite may no longer run',
  payload(run({ updated_at: ago(15 * 24 * 60) })),
  true,
  /15 days old/,
);
check(
  'a green verdict 13 days old is still quiet',
  payload(run({ updated_at: ago(13 * 24 * 60) })),
  false,
  /success/,
);

// ------------------------------------------- the control this drill needs most
// If `judge` were replaced by `() => ({alert:true})` every ALERT case above
// would still pass. These two are the ones that would not.
check('control: the quiet path is reachable at all', payload(run()), false);
check('control: the alert path is reachable at all', payload(), true);

console.log('main-red drill\n');
for (const c of cases) c();
console.log(`\n${pass}/${cases.length} pass`);
if (pass !== cases.length) process.exit(1);
