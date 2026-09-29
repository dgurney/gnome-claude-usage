import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export const STATUS_PAGE_URL = 'https://status.claude.com';
const SUMMARY_URL = `${STATUS_PAGE_URL}/api/v2/summary.json`;

// Returns the status of Claude's services as {description, incidents}, where
// incidents holds the names of the unresolved incidents.
export async function fetchServiceStatus(session, cancellable) {
    const message = Soup.Message.new('GET', SUMMARY_URL);
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    if (message.status_code !== Soup.Status.OK) {
        throw new Error(`Status request failed with HTTP ${message.status_code}`);
    }
    return parseServiceStatus(JSON.parse(new TextDecoder().decode(bytes.get_data())));
}

export function parseServiceStatus(data) {
    return {description: data.status.description, incidents: data.incidents.map(incident => incident.name)};
}
