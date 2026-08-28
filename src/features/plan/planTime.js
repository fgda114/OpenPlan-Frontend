/*
  Pure date/time helpers for the weekly calendar (ST-F1-02). No React, no I/O —
  just deterministic math so the grid, drag snapping, and week navigation all
  agree on a single definition of "a week", "day index", and "minutes of day".

  Conventions locked here:
  - A week starts on Monday (design PNGs show 월 first; user_profiles.week_start_day
    is honored via `weekStartsOn` where passed, default 1 = Monday).
  - Dates that identify a week or a day are ISO date strings 'YYYY-MM-DD' (matches
    weekly_plans.week_start_date). Block instants are ISO timestamps (start_at).
  - "minutes of day" = 0..1440, local time, the vertical axis unit.
*/

export const DAY_MS = 24 * 60 * 60 * 1000
export const MINUTES_PER_DAY = 24 * 60
export const SNAP_MINUTES = 5

// Monday-first short labels, index 0..6 = the 7 grid columns.
export const WEEKDAY_LABELS_KO = ['월', '화', '수', '목', '금', '토', '일']
// Weekend columns get a sunken tint (design): indices 5 (토) and 6 (일).
export const WEEKEND_COLUMN_INDICES = new Set([5, 6])

// Canonical weekday keys used by availability_patterns.weekday, aligned to the
// Monday-first column order so a column index maps straight to a pattern.
export const WEEKDAY_KEYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

/** Parse 'YYYY-MM-DD' as a LOCAL midnight Date (not UTC — avoids off-by-one). */
export function parseISODate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Format a Date as a local 'YYYY-MM-DD' string. */
export function formatISODate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Monday (or configured start) of the week containing `date`. */
export function weekStartOf(date, weekStartsOn = 1) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const offset = (d.getDay() - weekStartsOn + 7) % 7
  d.setDate(d.getDate() - offset)
  return d
}

/** The week-start ISO date for the week containing today. */
export function currentWeekStartISO(weekStartsOn = 1) {
  return formatISODate(weekStartOf(new Date(), weekStartsOn))
}

/** Add whole weeks to a week-start ISO date, returning a new ISO date. */
export function addWeeksISO(weekStartISO, delta) {
  const d = parseISODate(weekStartISO)
  d.setDate(d.getDate() + delta * 7)
  return formatISODate(d)
}

/** Add whole days to an ISO date. */
export function addDaysISO(dateISO, delta) {
  const d = parseISODate(dateISO)
  d.setDate(d.getDate() + delta)
  return formatISODate(d)
}

/** The 7 day ISO dates of a week, Monday-first. */
export function weekDays(weekStartISO) {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(weekStartISO, i))
}

/**
 * "N월 M주차" label. Week 1 is the week that contains the 1st of the month, so a
 * week whose Monday is the 23rd of a month whose 1st falls on a Sunday reads as
 * the 5th week — matching the reference design ("3월 5주차"). Labeled by the
 * week-start's month when a week spans a month boundary.
 */
export function weekLabelKO(weekStartISO) {
  const start = parseISODate(weekStartISO)
  const month = start.getMonth()
  const firstOfMonth = new Date(start.getFullYear(), month, 1)
  // Monday-based offset of the 1st (Mon=0 .. Sun=6).
  const firstOffset = (firstOfMonth.getDay() + 6) % 7
  const weekOfMonth = Math.ceil((start.getDate() + firstOffset) / 7)
  return `${month + 1}월 ${weekOfMonth}주차`
}

/** Snap a minute value to the nearest 5-minute grid, clamped to [0, 1440]. */
export function snapMinutes(minutes, snap = SNAP_MINUTES) {
  const snapped = Math.round(minutes / snap) * snap
  return Math.max(0, Math.min(MINUTES_PER_DAY, snapped))
}

/**
 * Snap a task/schedule's estimated DURATION (not a point in time) to the same
 * 5-minute grid `snapMinutes` enforces for block edges — the real server 422s
 * a block whose start/end isn't a 5-minute multiple (E-COM-009), and an end
 * time is always built as `start + duration`, so a duration that isn't
 * already 5-aligned breaks the invariant just as surely as an unsnapped start
 * would (see clampBlockSpan below, which composes the two).
 *
 * `null`/`undefined`/non-finite pass straight through UNCHANGED rather than
 * coercing to a number — this runs at read boundaries that also need to tell
 * "no estimate" apart from "a zero-minute one" (callers already do
 * `?? 60`-style fallbacks around this; fabricating a number here would hide
 * that distinction one layer earlier than every existing caller expects).
 *
 * ROUNDING DIRECTION — nearest, not floor/ceil, floored at one grid step (5)
 * so a task never collapses to a zero-length block: always-floor would
 * shrink a task's remaining/estimated time a little EVERY time this runs
 * (each partial placement, each re-normalize on refetch), compounding into a
 * real loss of planned time across a session; always-ceil has the mirror
 * problem, compounding into an ever-growing overstatement that nudges the
 * daily-availability check (V4 가용 시간 초과) toward false positives the more
 * a task gets split/replaced. Nearest keeps the drift at a single bounded
 * ±2.5min per call with NO cumulative bias in either direction — the same
 * trade snapMinutes already made for the drag grid, so a block's start and
 * its duration agree on which rounding rule governs "close enough".
 */
export function snapDuration(minutes, snap = SNAP_MINUTES) {
  const n = Number(minutes)
  if (minutes == null || !Number.isFinite(n)) return minutes
  return Math.max(snap, Math.round(n / snap) * snap)
}

/**
 * Resolve a block's [startMin, endMin) span from a placement's start +
 * duration, closing THREE ways the 5-minute invariant used to break at once:
 *   1. `durationMin` might not already be a 5-minute multiple (an AI
 *      suggestion, a partial-placement remainder, stale data) — snapped here
 *      via `snapDuration` so every call site stops having to remember to.
 *   2. `startMin + duration` can run past midnight; the clamp below
 *      (`end = 1440; start = 1440 − duration`) is the SAME rule every call
 *      site used to hand-roll, just centralized — and because it now clamps
 *      the ALREADY-snapped duration, the shifted startMin stays 5-aligned too
 *      (1440 itself is a 5-multiple, so 1440 − a 5-multiple always is).
 *   3. a `duration` LONGER than a whole day (a large, not-yet-split task
 *      dragged straight onto the grid via the panel→grid drop, which never
 *      runs findFirstFreeSlot at all — see WeeklyPage.placeTaskAt/quickPlace's
 *      own comments on that split) would make rule 2's `1440 − duration`
 *      formula go NEGATIVE. A negative startMin isn't just out-of-range: fed
 *      into composeTimestamp, `Date.setMinutes(negative)` silently rolls onto
 *      the PREVIOUS day, so the block would save on a different date than the
 *      one the user actually dropped it on — a worse failure than merely
 *      running past midnight. `Math.max(0, …)` below clamps start at the top
 *      of the day instead, producing a FULL-day block (0..1440) that covers
 *      less than the task's own estimate. That shortfall is deliberately not
 *      an error: this app already models "placed less than estimated" as a
 *      normal, first-class state (placedRemainders/A4 — the difference
 *      resurfaces in the unplaced panel as the task's remaining time), so a
 *      day-filling block + a remainder is the SAME shape every other partial
 *      placement already produces, not a new case invented for this one.
 *
 * Given (2) and (3) never both apply (a normal ≤1-day duration only ever
 * needs the plain `1440 − duration` shift; only a >1-day duration needs the
 * floor), one `Math.max(0, …)` safely covers both — for `duration ≤ 1440` it
 * never changes the result, since `1440 − duration` is already ≥ 0.
 *
 * `durationMin` must resolve (after snapDuration) to a finite number — every
 * real caller already falls back to a default (`task.estimatedMinutes ?? 60`)
 * before reaching here, so a non-finite value getting this far means a NEW
 * caller skipped that guard. This throws immediately rather than letting a
 * fabricated placeholder duration silently place a wrong-sized block, or
 * letting NaN start/end times reach composeTimestamp, where
 * `Date.setMinutes(NaN)` produces an Invalid Date whose `.toISOString()`
 * throws a RangeError several calls away from the actual mistake.
 *
 * Returns both ends (not just endMin) because an overnight/overlong clamp
 * shifts startMin too — exactly what every caller already did by hand before
 * this existed.
 */
export function clampBlockSpan(startMin, durationMin) {
  const duration = snapDuration(durationMin)
  if (!Number.isFinite(duration)) {
    throw new Error(
      `clampBlockSpan: durationMin must be a finite number (got ${JSON.stringify(durationMin)}). ` +
        'Callers are expected to fall back to a default (e.g. `task.estimatedMinutes ?? 60`) before ' +
        'calling this — see this function\'s own header.',
    )
  }
  let start = startMin
  let end = start + duration
  if (end > MINUTES_PER_DAY) {
    end = MINUTES_PER_DAY
    start = Math.max(0, MINUTES_PER_DAY - duration)
  }
  return { startMin: start, endMin: end }
}

/** Minutes-of-day (local) for an ISO timestamp. */
export function minutesOfDay(iso) {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

/** The local ISO date ('YYYY-MM-DD') an ISO timestamp falls on. */
export function dateOf(iso) {
  return formatISODate(new Date(iso))
}

/**
 * Build an ISO timestamp from a day ISO date + minutes-of-day. Used when a drag
 * commits a new block position back to an absolute start_at/end_at.
 */
export function composeTimestamp(dayISO, minutes) {
  const d = parseISODate(dayISO)
  d.setMinutes(minutes)
  // `d` is built and mutated entirely in LOCAL time (parseISODate + setMinutes
  // above never touch UTC fields), but toISOString() always serializes to UTC
  // ('Z') regardless — there is no "local ISO" string format. That's fine here:
  // the string still encodes the same instant, and minutesOfDay/dateOf read it
  // back with `new Date(iso).getHours()/.getMinutes()`, which are local-time
  // accessors. As long as this round-trip runs in one consistent timezone (the
  // mock and grid both do, in the browser), the local wall-clock value we set
  // above comes back unchanged even though it passed through a UTC string.
  return d.toISOString()
}

/** "9:05" style short time from minutes-of-day. */
export function formatMinutesLabel(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

/** "6시간 40분" style duration from a minute count (0분 hidden when whole hours). */
export function formatDurationKO(totalMinutes) {
  const h = Math.floor(totalMinutes / 60)
  const m = Math.round(totalMinutes % 60)
  if (h && m) return `${h}시간 ${m}분`
  if (h) return `${h}시간`
  return `${m}분`
}

/** True when a week-start ISO date is strictly before this week (read-only, AC-5). */
export function isPastWeek(weekStartISO, weekStartsOn = 1) {
  return weekStartISO < currentWeekStartISO(weekStartsOn)
}
