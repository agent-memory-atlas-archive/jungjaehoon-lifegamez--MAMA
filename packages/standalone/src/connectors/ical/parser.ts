export interface ParsedICalEvent {
  uid: string;
  start: string;
  end: string;
  summary: string;
  status: 'confirmed' | 'cancelled' | string;
  revisionTime: number;
}

function unescapeText(value: string): string {
  return value
    .replace(/\\[nN]/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function zonedEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(wall));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return wall - (represented - wall);
}

function parseDate(value: string, zone?: string): { display: string; ms: number } {
  if (/^\d{8}$/.test(value)) {
    const display = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    return { display, ms: Date.parse(`${display}T00:00:00+09:00`) };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?$/.exec(value);
  if (!match) throw new Error(`invalid date-time value ${value}`);
  const [, y, mo, d, h, mi, s, suffix] = match;
  const local = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  let ms: number;
  if (suffix === 'Z') ms = Date.parse(`${local}Z`);
  else if (suffix) ms = Date.parse(`${local}${suffix.slice(0, 3)}:${suffix.slice(3)}`);
  else
    ms = zonedEpoch(
      Number(y),
      Number(mo),
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      zone || 'Asia/Seoul'
    );
  if (!Number.isFinite(ms)) throw new Error(`invalid date-time value ${value}`);
  return { display: new Date(ms).toISOString(), ms };
}

function property(event: Map<string, string>, key: string): string | undefined {
  return event.get(key);
}

export function parseICalendar(source: string): ParsedICalEvent[] {
  if (typeof source !== 'string' || source.trim() === '')
    throw new Error('empty calendar document');
  if (!/BEGIN:VCALENDAR/.test(source) || !/END:VCALENDAR\s*$/.test(source.trim())) {
    throw new Error('missing VCALENDAR boundary');
  }
  const unfolded = source.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: Map<string, string>[] = [];
  let current: Map<string, string> | undefined;
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') {
      if (current) throw new Error('nested VEVENT');
      current = new Map();
      continue;
    }
    if (line === 'END:VEVENT') {
      if (!current) throw new Error('END:VEVENT without BEGIN:VEVENT');
      events.push(current);
      current = undefined;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error('malformed VEVENT property');
    const [name, ...parameters] = line.slice(0, colon).split(';');
    const key = name!.toUpperCase();
    const params = new Map(
      parameters.map((entry) => {
        const split = entry.indexOf('=');
        return [entry.slice(0, split).toUpperCase(), entry.slice(split + 1).replace(/^"|"$/g, '')];
      })
    );
    current.set(key, JSON.stringify({ value: line.slice(colon + 1), zone: params.get('TZID') }));
  }
  if (current) throw new Error('unterminated VEVENT');
  return events.map((event) => {
    const read = (key: string): { value: string; zone?: string } | undefined => {
      const serialized = property(event, key);
      return serialized === undefined
        ? undefined
        : (JSON.parse(serialized) as { value: string; zone?: string });
    };
    const uid = read('UID')?.value;
    const startValue = read('DTSTART');
    const endValue = read('DTEND');
    if (!uid || !startValue || !endValue) throw new Error('VEVENT requires UID, DTSTART and DTEND');
    const start = parseDate(startValue.value, startValue.zone);
    const end = parseDate(endValue.value, endValue.zone);
    if (end.ms < start.ms) throw new Error(`VEVENT ${uid} ends before it starts`);
    const summary = unescapeText(read('SUMMARY')?.value ?? '(Untitled event)');
    const status = read('STATUS')?.value.toLowerCase() === 'cancelled' ? 'cancelled' : 'confirmed';
    const modified = read('LAST-MODIFIED') ?? read('DTSTAMP');
    const revisionTime = modified ? parseDate(modified.value, modified.zone).ms : start.ms;
    return { uid, start: start.display, end: end.display, summary, status, revisionTime };
  });
}
