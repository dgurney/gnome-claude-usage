// Run with `make test`, which pins TZ and locale so clock times are deterministic.
import {formatClockTime, formatDuration, formatReset, percentLeft, usageLevel} from '../format.js';
import {RateLimitedError, SignInExpiredError, UsageError, parseSignIn, parseUsage, responseError} from '../usage.js';

let failures = 0;

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e)
        return;
    failures++;
    printerr(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Tuesday 2026-09-29 14:00 UTC
const NOW = Date.parse('2026-09-29T14:00:00Z');

check('duration under an hour', formatDuration(42 * MINUTE), '42m');
check('duration rounds partial minutes up', formatDuration(30 * 1000), '1m');
check('duration in hours', formatDuration(2 * HOUR + 14 * MINUTE), '2h 14m');
check('duration in days', formatDuration(3 * DAY + 5 * HOUR + 59 * MINUTE), '3d 5h');

check('clock time today, 24h', formatClockTime(NOW + 4 * HOUR + 30 * MINUTE, NOW, true), '18:30');
check('clock time today, 12h', formatClockTime(NOW + 4 * HOUR + 30 * MINUTE, NOW, false), '6:30 PM');
check('clock time on a later day', formatClockTime(NOW + 3 * DAY, NOW, true), 'Fri 14:00');
check('clock time just past midnight is another day', formatClockTime(NOW + 10 * HOUR + MINUTE, NOW, true), 'Wed 00:01');

check('reset in the future', formatReset(NOW + 2 * HOUR, NOW, true), 'Resets in 2h 0m (16:00)');
check('reset already passed', formatReset(NOW - MINUTE, NOW, true), 'Resetting now');
check('reset not scheduled', formatReset(null, NOW, true), 'No reset scheduled');

check('percent left', percentLeft(37.4), 63);
check('percent left past the limit', percentLeft(112), 0);
check('usage level with plenty left', usageLevel(26), 'normal');
check('usage level when running low', usageLevel(25), 'warning');
check('usage level when nearly out', usageLevel(10), 'critical');

const RESPONSE = {
    five_hour: {utilization: 37.0, resets_at: '2026-09-29T18:30:00.123456+00:00'},
    seven_day: {utilization: 12.5, resets_at: '2026-10-02T09:00:00+00:00'},
    seven_day_opus: {utilization: 4, resets_at: '2026-10-02T09:00:00+00:00'},
    seven_day_sonnet: {utilization: 0, resets_at: null},
    seven_day_oauth_apps: null,
    extra_usage: {is_enabled: false, monthly_limit: null, used_credits: null, utilization: null},
    limits: [
        {kind: 'session', group: 'five_hour', percent: 37, resets_at: '2026-09-29T18:30:00Z', severity: 'ok', is_active: true, scope: null},
        {kind: 'session', group: 'five_hour', percent: 20, resets_at: '2026-09-29T18:30:00Z', severity: 'ok', is_active: false, scope: {model: {display_name: 'Haiku'}}},
        {kind: 'weekly_scoped', group: 'weekly', percent: 55, resets_at: '2026-10-02T09:00:00Z', severity: 'ok', is_active: false, scope: {model: {display_name: 'Fable'}}},
    ],
};
const SESSION = {title: 'Current session', utilization: 37, resetsAt: Date.parse('2026-09-29T18:30:00.123Z')};
const WEEK = {title: 'Current week (all models)', utilization: 12.5, resetsAt: Date.parse('2026-10-02T09:00:00Z')};
const FABLE = {title: 'Current week (Fable)', utilization: 55, resetsAt: Date.parse('2026-10-02T09:00:00Z')};

check('parse usage on a Max plan', parseUsage(RESPONSE, 'max'), [
    SESSION,
    WEEK,
    {title: 'Current week (Sonnet only)', utilization: 0, resetsAt: null},
    FABLE,
]);
check('parse usage on a Pro plan hides the Sonnet limit', parseUsage(RESPONSE, 'pro'), [SESSION, WEEK, FABLE]);

check('parse skips windows without utilization', parseUsage({
    five_hour: {utilization: null, resets_at: null},
    seven_day: {utilization: 3, resets_at: '2026-10-02T09:00:00Z'},
}, 'max'), [
    {title: 'Current week (all models)', utilization: 3, resetsAt: Date.parse('2026-10-02T09:00:00Z')},
]);

check('successful response', responseError(200, null), null);
check('expired sign-in', responseError(401, null) instanceof SignInExpiredError, true);
check('forbidden', [responseError(403, null) instanceof UsageError, responseError(403, null) instanceof SignInExpiredError], [true, false]);
check('rate limited with retry-after', responseError(429, '120').retryAfterMs, 120000);
check('rate limited without retry-after', responseError(429, null).retryAfterMs, null);
check('rate limited is its own error', responseError(429, null) instanceof RateLimitedError, true);
check('other failures', responseError(500, null).message, 'Usage request failed with HTTP 500.');

function signInError(text) {
    try {
        parseSignIn(text);
    } catch (e) {
        return e instanceof UsageError ? e.message : `unexpected ${e}`;
    }
    return 'no error';
}

const NOT_SIGNED_IN = 'Claude Code is not signed in. Run `claude` to sign in.';
check('sign-in', parseSignIn(JSON.stringify({
    claudeAiOauth: {accessToken: 'access', refreshToken: 'refresh', expiresAt: 1, subscriptionType: 'pro'},
})), {accessToken: 'access', subscriptionType: 'pro'});
check('sign-in with unknown plan', parseSignIn(JSON.stringify({
    claudeAiOauth: {accessToken: 'access', refreshToken: 'refresh', expiresAt: 1},
})).subscriptionType, null);
check('only other sign-ins', signInError(JSON.stringify({mcpOAuth: {}})), NOT_SIGNED_IN);
check('sign-in emptied after a rejected renewal', signInError(JSON.stringify({
    claudeAiOauth: {accessToken: '', refreshToken: '', expiresAt: 0, subscriptionType: 'max'},
})), NOT_SIGNED_IN);

if (failures > 0)
    throw new Error(`${failures} test(s) failed`);
print('All tests passed');
