import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// libsoup has no constant for this status.
const HTTP_TOO_MANY_REQUESTS = 429;
export const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);

// Longer than Claude Code's own 30s limit on its token request, so a renewal
// is never killed after the server has issued new tokens but before they are saved.
const RENEWAL_TIMEOUT_SECONDS = 60;

// Claude Code only shows the Sonnet limit on these plans; on the others it
// matches the weekly limit. null means the plan is unknown.
const PLANS_WITH_SONNET_LIMIT = ['max', 'team', null];

// An error whose message is fit to show to the user as-is.
export class UsageError extends Error {}

export class SignInExpiredError extends UsageError {
    constructor() {
        super('The Claude Code sign-in has expired. Run `claude` to renew it.');
    }
}

export class RateLimitedError extends UsageError {
    // retryAfterMs is null when the server didn't say how long to wait.
    constructor(retryAfterMs) {
        super('Claude is limiting how often usage can be checked.');
        this.retryAfterMs = retryAfterMs;
    }
}

const NOT_SIGNED_IN = 'Claude Code is not signed in. Run `claude` to sign in.';

// Returns the Claude Code sign-in as {accessToken, subscriptionType}.
export async function readSignIn(cancellable) {
    let contents;
    try {
        [contents] = await Gio.File.new_for_path(CREDENTIALS_PATH).load_contents_async(cancellable);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
            throw new UsageError(NOT_SIGNED_IN);
        }
        throw e;
    }
    return parseSignIn(new TextDecoder().decode(contents));
}

export function parseSignIn(text) {
    // The file also holds other sign-ins, e.g. for MCP servers. Claude Code
    // empties the tokens when the server rejects a renewal.
    const oauth = JSON.parse(text).claudeAiOauth;
    if (oauth === undefined || oauth.refreshToken === '') {
        throw new UsageError(NOT_SIGNED_IN);
    }
    return {accessToken: oauth.accessToken, subscriptionType: oauth.subscriptionType ?? null};
}

// Returns the error for an unsuccessful response, or null for a successful one.
export function responseError(status, retryAfterHeader) {
    switch (status) {
        case Soup.Status.OK:
            return null;
        case Soup.Status.UNAUTHORIZED:
            return new SignInExpiredError();
        case Soup.Status.FORBIDDEN:
            return new UsageError(
                "This Claude Code sign-in isn't allowed to read usage. Try signing in again with `claude auth login`."
            );
        case HTTP_TOO_MANY_REQUESTS:
            return new RateLimitedError(retryAfterHeader === null ? null : Number(retryAfterHeader) * 1000);
        default:
            return new UsageError(`Usage request failed with HTTP ${status}.`);
    }
}

// Returns the usage limits as [{title, utilization, resetsAt}], where
// utilization is the percentage used and resetsAt is in ms since the epoch.
export async function fetchUsage(session, {accessToken, subscriptionType}, cancellable) {
    const message = Soup.Message.new('GET', USAGE_URL);
    message.request_headers.append('Authorization', `Bearer ${accessToken}`);
    message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    const error = responseError(message.status_code, message.response_headers.get_one('retry-after'));
    if (error !== null) {
        throw error;
    }

    return parseUsage(JSON.parse(new TextDecoder().decode(bytes.get_data())), subscriptionType);
}

// Has Claude Code renew its sign-in. `claude doctor` renews an expired sign-in
// the same way Claude Code does during normal use, including locking against
// other Claude Code processes. The extension never exchanges tokens itself, as
// Claude Code may issue a new refresh token and retire the old one.
export async function renewSignIn(cancellable) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    // doctor reads the settings in its working directory.
    launcher.set_cwd(GLib.get_home_dir());
    const proc = launcher.spawnv(['claude', 'doctor']);

    let timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RENEWAL_TIMEOUT_SECONDS, () => {
        timeoutId = 0;
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        // doctor's exit status reports its health checks, not the renewal. The
        // next usage request shows whether the renewal worked.
        await proc.wait_async(cancellable);
    } finally {
        if (timeoutId !== 0) {
            GLib.source_remove(timeoutId);
        }
    }
    if (timeoutId === 0) {
        throw new Error(`claude doctor didn't finish within ${RENEWAL_TIMEOUT_SECONDS}s`);
    }
}

function parseTime(time) {
    return time === null ? null : Date.parse(time);
}

export function parseUsage(data, subscriptionType) {
    const windows = [
        ['five_hour', 'Current session'],
        ['seven_day', 'Current week (all models)'],
    ];
    if (PLANS_WITH_SONNET_LIMIT.includes(subscriptionType)) {
        windows.push(['seven_day_sonnet', 'Current week (Sonnet only)']);
    }

    const limits = windows
        .filter(([key]) => data[key] && data[key].utilization !== null)
        .map(([key, title]) => ({title, utilization: data[key].utilization, resetsAt: parseTime(data[key].resets_at)}));

    for (const limit of data.limits ?? []) {
        if (limit.kind === 'weekly_scoped' && limit.scope?.model) {
            limits.push({
                title: `Current week (${limit.scope.model.display_name})`,
                utilization: limit.percent,
                resetsAt: parseTime(limit.resets_at),
            });
        }
    }
    return limits;
}
