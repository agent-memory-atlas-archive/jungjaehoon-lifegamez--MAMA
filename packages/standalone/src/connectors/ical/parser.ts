import { calendarValueKind } from '../../runtime/timezone.js';

export interface ParsedICalEvent {
  uid: string;
  start: string;
  startTimeZone?: string;
  end?: string;
  endTimeZone?: string;
  duration?: string;
  summary: string;
  status: 'confirmed' | 'cancelled' | string;
  revisionTime?: number;
}

function unescapeText(value: string): string {
  return value
    .replace(/\\[nN]/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function revisionEpoch(value: string): number {
  const kind = calendarValueKind(value);
  if (kind === 'date')
    return Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  const normalized = value
    .replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) throw new Error(`invalid date-time value ${value}`);
  return epoch;
}

function validateDuration(value: string): void {
  const match = /^P(?:(\d+)W|(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) throw new Error(`invalid duration value ${value}`);
}

function property(event: Map<string, string>, key: string): string | undefined {
  return event.get(key);
}

export function parseICalendar(source: string): ParsedICalEvent[] {
  if (typeof source !== 'string' || source.trim() === '')
    throw new Error('empty calendar document');
  if (!/BEGIN:VCALENDAR/.test(source) || !/END:VCALENDAR\s*$/.test(source.trim()))
    throw new Error('missing VCALENDAR boundary');
  const unfolded = source.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events: Map<string, string>[] = [];
  let current: Map<string, string> | undefined;
  // Components nested in a VEVENT (VALARM and the like) carry their own SUMMARY or DESCRIPTION;
  // their lines are skipped so they never overwrite the event's properties.
  let nested = 0;
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') {
      if (current) throw new Error('nested VEVENT');
      current = new Map();
      continue;
    }
    if (current && line.startsWith('BEGIN:')) {
      nested += 1;
      continue;
    }
    if (current && nested > 0) {
      if (line.startsWith('END:')) nested -= 1;
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
    const params = new Map(
      parameters.map((entry) => {
        const split = entry.indexOf('=');
        return [entry.slice(0, split).toUpperCase(), entry.slice(split + 1).replace(/^"|"$/g, '')];
      })
    );
    current.set(
      name!.toUpperCase(),
      JSON.stringify({ value: line.slice(colon + 1), zone: params.get('TZID') })
    );
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
    const duration = read('DURATION')?.value;
    if (!uid || !startValue) throw new Error('VEVENT requires UID and DTSTART');
    if (endValue && duration)
      throw new Error(`VEVENT ${uid} cannot contain both DTEND and DURATION`);
    const startKind = calendarValueKind(startValue.value);
    if (endValue) calendarValueKind(endValue.value);
    if (duration) validateDuration(duration);
    if (endValue && revisionEpoch(endValue.value) < revisionEpoch(startValue.value))
      throw new Error(`VEVENT ${uid} ends before it starts`);
    const modified = read('LAST-MODIFIED');
    return {
      uid,
      start: startValue.value,
      ...(startValue.zone ? { startTimeZone: startValue.zone } : {}),
      ...(endValue
        ? { end: endValue.value, ...(endValue.zone ? { endTimeZone: endValue.zone } : {}) }
        : {}),
      ...(duration ? { duration } : !endValue && startKind === 'date' ? { duration: 'P1D' } : {}),
      summary: unescapeText(read('SUMMARY')?.value ?? '(Untitled event)'),
      status: read('STATUS')?.value.toLowerCase() === 'cancelled' ? 'cancelled' : 'confirmed',
      ...(modified ? { revisionTime: revisionEpoch(modified.value) } : {}),
    };
  });
}
