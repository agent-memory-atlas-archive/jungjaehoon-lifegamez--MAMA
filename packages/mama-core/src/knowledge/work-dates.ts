/**
 * The grammar of the OwnerWorkPatch date fields.
 *
 * A patch can state a deadline two ways: `dueAt` is an exact instant (RFC 3339
 * with an explicit offset) and `deadline` is a bare calendar date. Readers fold
 * the patch and parse both fields strictly, so a malformed value committed here
 * makes the whole row unreadable. The writers validate before commit rather
 * than letting a strict read discover the damage at boot.
 *
 * This module owns the field grammar only. Zone arithmetic — which local date
 * an instant lands on, where a deadline day starts — belongs to the product's
 * board projection, not the commitment log.
 *
 * @module knowledge/work-dates
 */

import type { OwnerWorkPatch } from '../memory/judgment-types.js';
import { JudgmentError } from './judgments.js';

const RFC3339_EXACT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const WORK_PATCH_DUE_AT_PATTERN = RFC3339_EXACT_PATTERN.source;
export const WORK_PATCH_DEADLINE_PATTERN = ISO_DATE_PATTERN.source;

export interface ParsedExactDueAt {
  dueAt: number;
  deadline: string;
  offsetMinutes: number;
}

/**
 * Parse a `dueAt` value: an RFC 3339 timestamp with an explicit offset.
 *
 * A bare date is not an instant and a bare instant without an offset does not
 * say where midnight falls, so neither is accepted - the caller states the
 * offset it means.
 */
export function parseExactDueAt(value: string): ParsedExactDueAt {
  const match = RFC3339_EXACT_PATTERN.exec(value);
  if (!match) {
    throw new Error('due_at must be RFC 3339 with an explicit offset');
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    zone,
    sign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHours = zone === 'Z' ? 0 : Number(offsetHourText);
  const offsetMinutePart = zone === 'Z' ? 0 : Number(offsetMinuteText);
  const localDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const validLocalFields =
    localDate.getUTCFullYear() === year &&
    localDate.getUTCMonth() === month - 1 &&
    localDate.getUTCDate() === day &&
    localDate.getUTCHours() === hour &&
    localDate.getUTCMinutes() === minute &&
    localDate.getUTCSeconds() === second;
  const validOffset =
    offsetHours <= 14 && offsetMinutePart <= 59 && (offsetHours < 14 || offsetMinutePart === 0);
  const dueAt = Date.parse(value);
  if (!validLocalFields || !validOffset || !Number.isFinite(dueAt)) {
    throw new Error('due_at must be valid RFC 3339 with an explicit offset');
  }
  const offsetMagnitude = offsetHours * 60 + offsetMinutePart;
  const offsetMinutes = zone === 'Z' ? 0 : sign === '-' ? -offsetMagnitude : offsetMagnitude;
  return {
    dueAt,
    deadline: `${yearText}-${monthText}-${dayText}`,
    offsetMinutes,
  };
}

/**
 * Reject a `deadline` value that is not a real calendar date.
 *
 * `2026-02-30` matches the date pattern but is not a day that exists, and a
 * reader that computes the start of that day has no honest answer for it.
 */
export function assertIsoDate(value: string, field: string): void {
  if (!ISO_DATE_PATTERN.exec(value)) {
    throw new Error(`${field} must be an ISO date (YYYY-MM-DD), got: ${value}`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${field} must be an ISO date (YYYY-MM-DD), got: ${value}`);
  }
}

/**
 * Reject a work patch whose declared date fields cannot be read back.
 *
 * `null` is an absent statement, not a malformed one - the fold reads it as the
 * field cleared. A non-null value must be a well-formed string of its grammar.
 * What the fields mean together (whether `dueAt` and `deadline` may disagree)
 * is the board's contract, not the log's: this checks only that each stated
 * value parses.
 */
export function assertWorkPatchValues(set: OwnerWorkPatch): void {
  try {
    if (set.dueAt !== undefined && set.dueAt !== null) {
      if (typeof set.dueAt !== 'string') {
        throw new Error(`dueAt must be a string, got: ${typeof set.dueAt}`);
      }
      parseExactDueAt(set.dueAt);
    }
    if (set.deadline !== undefined && set.deadline !== null) {
      if (typeof set.deadline !== 'string') {
        throw new Error(`deadline must be a string, got: ${typeof set.deadline}`);
      }
      assertIsoDate(set.deadline, 'deadline');
    }
    if (set.deadlineOffsetMinutes !== undefined && set.deadlineOffsetMinutes !== null) {
      const offset = set.deadlineOffsetMinutes;
      if (!Number.isInteger(offset) || offset < -840 || offset > 840) {
        throw new Error(
          `deadlineOffsetMinutes must be an integer from -840 to 840, got: ${offset}`
        );
      }
    }
  } catch (error) {
    throw new JudgmentError(
      'INVALID_INPUT',
      error instanceof Error ? error.message : String(error)
    );
  }
}
