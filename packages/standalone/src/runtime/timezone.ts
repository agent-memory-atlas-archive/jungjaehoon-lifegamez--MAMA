export interface TimeZoneSetting {
  get(): string;
  set(timeZone: string): void;
}

export function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
  } catch {
    const error = new Error(`timezone "${timeZone}" is not a valid IANA time zone`);
    error.name = 'invalid_input';
    throw error;
  }
}

export function createTimeZoneSetting(initial: string): TimeZoneSetting {
  validateTimeZone(initial);
  let current = initial;
  return {
    get: () => current,
    set: (timeZone) => {
      validateTimeZone(timeZone);
      current = timeZone;
    },
  };
}

function partsAt(ms: number, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function localDateKey(ms: number, timeZone: string): string {
  const parts = partsAt(ms, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function epochAtLocalDateTime(value: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) throw new Error(`invalid local date-time ${value}`);
  const [, y, mo, d, h, mi, s, fraction = '0'] = match;
  const desired = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(fraction.padEnd(3, '0'))
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = partsAt(candidate, timeZone);
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      Number(fraction.padEnd(3, '0'))
    );
    const next = candidate + desired - represented;
    if (next === candidate) return candidate;
    candidate = next;
  }
  return candidate;
}

export function epochForCalendarValue(
  value: string,
  kind: string,
  eventTimeZone: string | undefined,
  ownerTimeZone: string
): number {
  if (kind === 'date') {
    const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
    if (!match) return Number.NaN;
    return epochAtLocalDateTime(
      `${match[1]}-${match[2]}-${match[3]}T00:00:00`,
      eventTimeZone ?? ownerTimeZone
    );
  }
  if (kind === 'utc' || kind === 'offset') {
    const normalized = value
      .replace(/^(\d{4})(\d{2})(\d{2})T/, '$1-$2-$3T')
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    return Date.parse(normalized);
  }
  if (kind === 'floating') {
    const normalized = value.replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/,
      '$1-$2-$3T$4:$5:$6'
    );
    return epochAtLocalDateTime(normalized, eventTimeZone ?? ownerTimeZone);
  }
  throw new Error(`unknown calendar value kind "${kind}"`);
}

export function durationEndEpoch(
  startValue: string,
  startKind: string,
  duration: string,
  zone: string
): number {
  const match = /^P(?:(\d+)W|(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration);
  if (!match) return Number.NaN;
  const start = epochForCalendarValue(startValue, startKind, undefined, zone);
  const dayCount = Number(match[1] ?? 0) * 7 + Number(match[2] ?? 0);
  const timeMs =
    Number(match[3] ?? 0) * 3_600_000 +
    Number(match[4] ?? 0) * 60_000 +
    Number(match[5] ?? 0) * 1_000;
  if (startKind === 'utc' || startKind === 'offset') return start + dayCount * 86_400_000 + timeMs;
  if (dayCount === 0) return start + timeMs;
  const local = /^\d{8}$/.test(startValue)
    ? `${startValue.slice(0, 4)}-${startValue.slice(4, 6)}-${startValue.slice(6, 8)}T00:00:00`
    : startValue.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6');
  const [date, clock] = local.split('T');
  const [year, month, day] = date!.split('-').map(Number);
  const [hour, minute, second] = clock!.split(':').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + dayCount, hour!, minute!, second!));
  const wall = `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}T${String(next.getUTCHours()).padStart(2, '0')}:${String(next.getUTCMinutes()).padStart(2, '0')}:${String(next.getUTCSeconds()).padStart(2, '0')}`;
  return epochAtLocalDateTime(wall, zone) + timeMs;
}
