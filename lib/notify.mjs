// Push notifications through ntfy.sh (free, no account; install the ntfy app
// and subscribe to your topic). Anyone who knows the topic name can read it,
// so make it long and random.

const PRIORITY = { info: 2, watch: 3, warning: 4, urgent: 5 };
const TAGS = { wind: 'dash', fire: 'fire', rain: 'cloud_with_rain', snow: 'snowflake', frost: 'snowflake',
  heat: 'sunny', thunder: 'zap', quake: 'warning', smoke: 'fog' };

export async function push(topic, a, { server = 'https://ntfy.sh', dashboardUrl } = {}) {
  const body = [a.body, a.actions?.length ? `\nDo now:\n• ${a.actions.slice(0, 3).join('\n• ')}` : ''].join('');
  const headers = {
    Title: encodeHeader(a.title),
    Priority: String(PRIORITY[a.level] ?? 3),
    Tags: TAGS[a.kind] ?? 'house',
  };
  const click = a.url ?? dashboardUrl;
  if (click) headers.Click = click;
  const res = await fetch(`${server}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
}

// HTTP headers must be ASCII; ntfy accepts RFC 2047 encoded words.
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

export async function heartbeat(url, ok = true) {
  if (!url) return;
  await fetch(ok ? url : `${url}/fail`, { method: 'POST' }).catch(() => {});
}
