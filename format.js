import GLib from 'gi://GLib';

const MINUTE_MS = 60 * 1000;

export function formatDuration(ms) {
    const totalMinutes = Math.ceil(ms / MINUTE_MS);
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return `${days}d ${hours}h`;
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

// Formats a time as "18:30" when it falls on the same day as `now`, or as
// "Fri 18:30" otherwise. Both arguments are ms since the epoch.
export function formatClockTime(time, now, use24h) {
    const date = GLib.DateTime.new_from_unix_local(Math.floor(time / 1000));
    const today = GLib.DateTime.new_from_unix_local(Math.floor(now / 1000));
    const clock = use24h ? '%H:%M' : '%-l:%M %p';
    const sameDay = date.get_year() === today.get_year() && date.get_day_of_year() === today.get_day_of_year();
    return date.format(sameDay ? clock : `%a ${clock}`);
}

export function formatReset(resetsAt, now, use24h) {
    if (resetsAt === null) {
        return 'No reset scheduled';
    }
    if (resetsAt <= now) {
        return 'Resetting now';
    }
    return `Resets in ${formatDuration(resetsAt - now)} (${formatClockTime(resetsAt, now, use24h)})`;
}

const WARNING_PERCENT_LEFT = 25;
const CRITICAL_PERCENT_LEFT = 10;

// Usage can go past 100% when extra usage is enabled.
export function percentLeft(utilization) {
    return Math.max(0, 100 - Math.round(utilization));
}

export function usageLevel(percent) {
    if (percent <= CRITICAL_PERCENT_LEFT) {
        return 'critical';
    }
    if (percent <= WARNING_PERCENT_LEFT) {
        return 'warning';
    }
    return 'normal';
}
