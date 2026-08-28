/*
  DEV-ONLY in-memory mock backend for the weekly plan (ST-F1-02).

  Why this exists: the real contract is the backend Swagger (BE-1), not yet
  running. Rather than branch the OP functions, planApi.js calls the real
  endpoints and — only in DEV, only on a network error — delegates here, exactly
  like sessionGuardLoader already does for /auth/session. When a real or Swagger
  mock server is reachable, this file is never touched, so the production path is
  "diff = base URL only" (build-plan §3).

  State is module-level and mutable so an optimistic drag that commits a PATCH
  actually sticks for the session, and undo/redo replays against consistent data.
*/

import {
  addDaysISO,
  addWeeksISO,
  clampBlockSpan,
  composeTimestamp,
  currentWeekStartISO,
  dateOf,
  formatMinutesLabel,
  minutesOfDay,
  snapDuration,
  WEEKDAY_KEYS,
  WEEKDAY_LABELS_KO,
  weekDays,
} from './planTime'
import { byDueThenPriority, byPriorityThenDue, findFirstFreeSlot } from './planPlacement'
import { availabilityForColumn } from './planGeometry'

// Simulated round-trip latency so the optimistic-then-commit flow stays
// observable (never 0 — that's the whole reason this DEV mock exists: seeing
// the optimistic write land instantly, then the background write/refetch settle
// a beat later). Kept deliberately short so the app doesn't feel laggy; each
// GET below still gets its OWN (smaller) explicit delay on top of whatever it
// does, so multi-request chains (e.g. delete → week refetch → unplaced
// refetch) don't stack up into a visibly slow interaction.
const MOCK_LATENCY_MS = 70
const delay = (ms = MOCK_LATENCY_MS) => new Promise((r) => setTimeout(r, ms))

let uid = 100
const nextId = (prefix) => `${prefix}-${(uid += 1)}`

// FIX (ST-F1-09 code review, Thomas — BLOCKER): every TASK id THIS mock mints
// uses the `plan-task` prefix, deliberately DIFFERENT from
// projectFixtures.js's own `task` prefix. Both modules start their own local
// `uid` counter at 100, so with a shared prefix they would mint COLLIDING ids
// (both produce `task-101`, `task-102`, …) — projectApi.getTask (ST-F1-09,
// GET /tasks/{taskId}) searches ONLY the project store, so a colliding id
// reached via WeeklyPage.jsx's "태스크 편집" context menu (which passes a
// PLAN block's taskId, minted here) would silently resolve to an unrelated
// PROJECT task and let the edit page save over it — no error, wrong data.
// A distinct prefix makes the two stores' id spaces disjoint BY CONSTRUCTION
// (no counter-coordination needed), so a plan-only id can never accidentally
// match a project task. No plan-feature code parses/matches taskId by string
// shape (grepped before this change), so the prefix itself is free to change.
//
// FOLLOW-UP (owner review, dev-server walkthrough): a `plan-task-*` id used
// to just 404 at projectApi.getTask past this point — correct-but-incomplete,
// since the owner confirmed a plan block IS a real, editable task in
// production (the 404 was purely this DEV-mock split, not a real state).
// projectApi.getTask now routes a `plan-task-*` id to THIS module's own
// getTask/updateTask (below, near setTaskStatus) instead of 404ing — the
// disjoint-prefix guarantee THIS comment describes is exactly what makes
// that routing safe (a plan id can never accidentally reach the PROJECT
// store's getTask and edit the wrong task — the original BLOCKER this fix
// prevents). A truly unknown id (neither prefix's store has it) still 404s.

// Seed availability: Mon–Fri 09:00–18:00 active, weekend off.
function seedAvailability() {
  return WEEKDAY_KEYS.map((weekday, i) => ({
    weekday,
    startMinutes: 9 * 60,
    endMinutes: 18 * 60,
    isActive: i < 5,
  }))
}

// Seed blocks for a week, positioned to mirror the reference design. `tone` is a
// placeholder for future project coloring (real palette lands with projects).
function seedBlocks(weekStartISO) {
  const day = (offset) => addDaysISO(weekStartISO, offset)
  const mk = (offset, startMin, endMin, title, blockType, tone) => {
    let scheduleId = null
    let taskId = null
    if (blockType === 'SCHEDULE') {
      scheduleId = nextId('sched')
      // Register the schedule so 일정 편집 (PLAN-17) can prefill its full fields.
      schedulesById.set(scheduleId, {
        scheduleId,
        title,
        estimatedMinutes: endMin - startMin,
        priority: 2,
        memo: '',
        status: 'ACTIVE',
      })
    } else {
      taskId = nextId('plan-task')
      // Register the task with its estimate = initial duration, so A4 remainder
      // works when a SEEDED task block is shrunk (est − placed > 0).
      placedTaskData.set(taskId, {
        taskId,
        title,
        estimatedMinutes: endMin - startMin,
        priority: 2,
        projectId: null,
        projectName: null,
        dueDate: null,
        reason: null,
      })
    }
    return {
      planBlockId: nextId('block'),
      blockType,
      title,
      tone,
      status: 'SCHEDULED',
      taskId,
      scheduleId,
      startAt: composeTimestamp(day(offset), startMin),
      endAt: composeTimestamp(day(offset), endMin),
    }
  }
  return [
    mk(0, 9 * 60 + 5, 10 * 60 + 35, '면접 대비 예상 질문 리스트업', 'TASK', 'brand'),
    mk(1, 10 * 60 + 45, 12 * 60 + 40, '대시보드 개선', 'TASK', 'accent'),
    mk(2, 10 * 60 + 50, 12 * 60 + 10, '모의 면접 답변 1차 정리', 'TASK', 'brand'),
    mk(2, 14 * 60 + 15, 15 * 60 + 10, '자기소개 스크립트', 'TASK', 'brand'),
    mk(4, 15 * 60, 16 * 60, '병원 방문', 'SCHEDULE', null),
  ]
}

// DEV-ONLY seed for the PREVIOUS week (ST-F1-02 AC-5 demo). Without this, a
// past week's grid is empty in the mock — ensureWeek only ever creates a week
// the first time something asks for it, and nothing asks for a past one until
// the user navigates ‹ into it, so there was no way to see (or verify) the
// AC-5 carve-out (완료 전환/실제 시간 기록 stay usable on a read-only past week,
// everything else stays blocked) without hand-building a past plan first. Mix
// of TASK (one COMPLETED, one not — both toggle directions are reachable) and
// SCHEDULE (menuItemsFor returns [] for a past-week SCHEDULE; a TASK block
// returns [complete, log] — see WeeklyPage.jsx) so a 우클릭 on each contrasts
// directly against the other. Deliberately much smaller than seedBlocks (this
// week) and produces no validation issues of its own — it exists to exercise
// AC-5, not to re-demo ST-F1-05's blocking-violation case a second time.
function seedPastWeekBlocks(weekStartISO) {
  const day = (offset) => addDaysISO(weekStartISO, offset)
  const mk = (offset, startMin, endMin, title, blockType, status) => {
    let scheduleId = null
    let taskId = null
    if (blockType === 'SCHEDULE') {
      scheduleId = nextId('sched')
      schedulesById.set(scheduleId, {
        scheduleId,
        title,
        estimatedMinutes: endMin - startMin,
        priority: 2,
        memo: '',
        status: 'ACTIVE',
      })
    } else {
      taskId = nextId('plan-task')
      placedTaskData.set(taskId, {
        taskId,
        title,
        estimatedMinutes: endMin - startMin,
        priority: 2,
        projectId: null,
        projectName: null,
        dueDate: null,
        reason: null,
      })
    }
    return {
      planBlockId: nextId('block'),
      blockType,
      title,
      tone: blockType === 'TASK' ? 'brand' : null,
      status,
      taskId,
      scheduleId,
      startAt: composeTimestamp(day(offset), startMin),
      endAt: composeTimestamp(day(offset), endMin),
    }
  }
  return [
    // TASK, already completed — "완료로 표시" should offer "미완료로 되돌리기".
    // MON 10:30 (not 09:00): this week's fixed schedule "아침 스터디" runs
    // MON 09:00-10:00 (seedFixedSchedules) — starting after it avoids a V2
    // 고정 일정 충돌 this seed isn't meant to demonstrate (that's ST-F1-05's
    // OWN seed, on the CURRENT week, above).
    mk(0, 10 * 60 + 30, 12 * 60, '지난주 발표 자료 준비', 'TASK', 'COMPLETED'),
    // TASK, still open — "완료로 표시" should offer the forward direction.
    mk(1, 10 * 60, 11 * 60, '주간 회고 정리', 'TASK', 'SCHEDULED'),
    // SCHEDULE — its menu should be EMPTY on a past week (no 완료/기록 concept).
    mk(2, 14 * 60, 15 * 60, '치과 예약', 'SCHEDULE', 'SCHEDULED'),
    // A second completed TASK, on a different day (THU — clear of THU's own
    // fixed "주간 팀 회의" 11:00-12:00), so 실제 시간 기록 has more than one
    // candidate block to try it on.
    mk(3, 9 * 60 + 30, 10 * 60 + 30, '코드 리뷰', 'TASK', 'COMPLETED'),
  ]
}

// Backlog of UNASSIGNED tasks the unplaced panel lists (ST-F1-03). Global (not
// per-week) — a task is a candidate for any week until it's placed as a block.
function seedUnplacedTasks() {
  const mk = (title, estimatedMinutes, priority, projectId, projectName, dueOffset) => ({
    taskId: nextId('plan-task'),
    projectId,
    projectName,
    title,
    estimatedMinutes,
    priority,
    dueDate: dueOffset == null ? null : addDaysISO(currentWeekStartISO(), dueOffset),
    reason: null,
  })
  return [
    mk('채용 공고 리서치·정리', 90, 1, 'proj-1', '취업 준비', 3),
    mk('포트폴리오 프로젝트 회고 작성', 120, 2, 'proj-1', '취업 준비', 6),
    mk('알고리즘 문제 풀이 세트', 60, 2, 'proj-2', '코딩 테스트', null),
    mk('영어 인터뷰 표현 암기', 45, 3, 'proj-1', '취업 준비', 9),
    mk('이력서 최종 검토', 30, 1, 'proj-1', '취업 준비', 1),
  ]
}

/*
  Fixed schedules (recurring, immovable). The real surface for these is ST-F1-06;
  they exist here NOW because the V2 (고정 일정 충돌) rule is unverifiable without
  them — the seeded 월 09:05 task block deliberately overlaps 아침 스터디 so the
  blocking violation, the disabled save button and the review panel are all
  visible on first load rather than only after the user constructs a conflict.
  They are not returned as plan blocks, so the grid is unchanged.
*/
function seedFixedSchedules() {
  // version/effectiveFrom/effectiveTo/source/status mirror the ERD fields
  // ST-B2-12 documents (fixed_schedules table) — ST-F1-06 only ever READ
  // weekday/start/end, so those four were never seeded until ST-F1-12's CRUD
  // needed them (optimistic lock + MANUAL-only status-edit guard, §ST-B2-12 AC-4).
  return [
    {
      fixedScheduleId: nextId('fixed'),
      title: '아침 스터디',
      weekday: 'MON',
      startMinutes: 9 * 60,
      endMinutes: 10 * 60,
      effectiveFrom: null,
      effectiveTo: null,
      source: 'MANUAL',
      status: 'ACTIVE',
      version: 1,
    },
    {
      fixedScheduleId: nextId('fixed'),
      title: '주간 팀 회의',
      weekday: 'THU',
      startMinutes: 11 * 60,
      endMinutes: 12 * 60,
      effectiveFrom: null,
      effectiveTo: null,
      source: 'MANUAL',
      status: 'ACTIVE',
      version: 1,
    },
  ]
}

// Per-week plan store, created lazily on first access to a week.
const weeks = new Map()
let availability = seedAvailability()
const fixedSchedules = seedFixedSchedules()
// ST-F1-06 week exceptions: fixedScheduleId -> Set<weekStartISO> currently
// "이번 주만 비활성화". A Set (not a boolean) because the toggle is PER WEEK — the
// same fixed schedule can be deactivated for one week and stay active every other
// week, which is the whole point of PLAN-33/34 (never a global on/off).
const weekExceptionsByFixedId = new Map()

// True unless THIS week has an exception recorded for THIS fixed schedule. Read
// by both the V2 rule (a deactivated fixed schedule stops blocking) and
// getFixedSchedules (the `activeThisWeek` the ghost display keys off).
function isFixedActiveForWeek(fixed, weekStartISO) {
  return !weekExceptionsByFixedId.get(fixed.fixedScheduleId)?.has(weekStartISO)
}

/*
 * ST-F1-12 (settings) 고정 일정 충돌 미리보기's mock backbone. Mirrors the SAME
 * overlap test the V2 rule above uses, just run against a CANDIDATE window
 * (not-yet-saved weekday/start/end) instead of an already-seeded fixed
 * schedule — that's the whole meaning of a "dry-run" per ST-B2-12 AC-1
 * ("가상 고정일정을 저장된 계획이 있는 주차들 스냅샷에 포함해 validate").
 *
 * Only scans weeks THIS mock already knows about (`weeks` — every week the
 * user has actually opened this session): a mock has no real calendar
 * horizon to scan "all future weeks" against, and the settings screen only
 * needs to demonstrate "conflict found / not found", not an exhaustive
 * server-side sweep.
 */
function scanFixedConflicts(weekday, startMinutes, endMinutes) {
  const dayIndex = WEEKDAY_KEYS.indexOf(weekday)
  if (dayIndex < 0) return []
  const affected = []
  for (const week of weeks.values()) {
    const dayISO = weekDays(week.weekStartDate)[dayIndex]
    const conflicts = week.blocks.filter((b) => {
      if (dateOf(b.startAt) !== dayISO) return false
      const bStart = minutesOfDay(b.startAt)
      const bEnd = minutesOfDay(b.endAt)
      return bStart < endMinutes && startMinutes < bEnd
    })
    if (conflicts.length > 0) {
      affected.push({
        weekStartDate: week.weekStartDate,
        conflictCount: conflicts.length,
        blockTitles: conflicts.map((b) => b.title),
      })
    }
  }
  return affected
}
let unplacedTasks = seedUnplacedTasks()
// Full data of tasks that have been placed as blocks, kept so "배치 해제" (PLAN-16)
// can restore the original task to the unplaced backlog (and later A4 remainder).
const placedTaskData = new Map()
// SCHEDULE records (ST-F1-04 PLAN-08/17). A schedule owns the fields the plan_block
// doesn't (memo·estimatedMinutes·priority); the block mirrors its title/time.
const schedulesById = new Map()
// Execution records (PLAN-15 실제 시간 기록) — write-only for this cycle.
const executionRecords = []

// Remember a task's full record when it leaves the backlog (placed as a block).
// Once placed, a task lives in placedTaskData permanently — its UNPLACED presence
// is then derived as a REMAINDER (est − placed), so a shrink-resize (A4) or a full
// unplace (PLAN-16) both just surface as more remaining time.
function rememberPlaced(taskId) {
  const src = unplacedTasks.find((t) => t.taskId === taskId)
  if (src && !placedTaskData.has(taskId)) placedTaskData.set(taskId, { ...src, reason: null })
}

// Total minutes a task currently occupies across all weeks' blocks.
function placedMinutesOf(taskId) {
  let total = 0
  for (const week of weeks.values()) {
    for (const b of week.blocks) {
      if (b.taskId === taskId) {
        total += (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60000
      }
    }
  }
  return total
}

// Placed tasks whose blocks cover LESS than their estimate → the leftover shows
// back in the unplaced panel as a remainder (A4 "남은 시간은 미배치에 다시 계산").
function placedRemainders() {
  const out = []
  for (const task of placedTaskData.values()) {
    const placed = placedMinutesOf(task.taskId)
    const remaining = (task.estimatedMinutes ?? 0) - placed
    if (remaining >= 5) {
      out.push({
        ...task,
        // snapDuration, not a plain Math.round: an A4 shrink-resize can leave
        // a `remaining` that isn't a 5-minute multiple even though the task's
        // OWN estimate and every placed block were (e.g. est 107 − placed 60
        // = 47), and this remainder becomes the next quickPlace/auto-place's
        // OWN durationMin — see taskApi.normalizeTask's matching comment for
        // why the read boundary is where this gets caught. ROUND-NEAREST
        // (not floor/ceil) is deliberate: a task can be split repeatedly
        // across several partial placements, and floor/ceil would each
        // compound a ONE-DIRECTIONAL bias every time (always losing a little
        // planned time, or always inflating it toward a V4 가용 시간 초과 false
        // positive) — nearest keeps the drift bounded and zero-expectation
        // instead of accumulating.
        estimatedMinutes: snapDuration(remaining),
        // Only a PARTIALLY-placed task is a "placed shorter than planned"
        // remainder; a fully-unplaced one (placed 0) is just a normal backlog item.
        reason: placed > 0 ? '예정보다 짧게 배치되어 남은 시간이 있습니다' : null,
      })
    }
  }
  return out
}

/*
  --- SCR-TASK-EDIT bridge (ST-F1-09, owner follow-up) ---------------------

  Originally this store had no generic "get/update a task by id" — every
  consumer here reads a task bundled with something else (a block, the
  unplaced list). SCR-TASK-EDIT's WeeklyPage entry point ("태스크 편집" on a
  placed block) needs exactly that, by a bare `plan-task-*` id, and the owner
  confirmed a plan block IS a real, editable task in production (the
  not-found this used to show was a DEV-mock artifact of the project/plan
  stores staying separate, not a real state) — see projectApi.getTask's own
  header for the namespace-routing that calls into this section, and
  planFixtures.js's own `nextId('plan-task')` comment for why routing by id
  PREFIX is safe (the two stores' ids can never collide).

  `placedTaskData` is checked before `unplacedTasks`: once a task has EVER
  been placed it lives there permanently (rememberPlaced's own header) and is
  the richer, canonical record; `unplacedTasks` only holds tasks that were
  NEVER placed at all. A task placed once then fully unplaced again is NOT
  back in `unplacedTasks` (its backlog presence is a computed `placedRemainders`
  entry, not real membership) — placedTaskData.get still finds it correctly.
*/
function findPlanTaskSource(taskId) {
  return placedTaskData.get(taskId) ?? unplacedTasks.find((t) => t.taskId === taskId) ?? null
}

// A plan-origin task has no explicit status field until it is edited via
// SCR-TASK-EDIT (below), which then persists one exactly like the project
// store always has. Before that first edit, status is DERIVED — mirrors
// TaskRow.jsx's own UNASSIGNED/IN_PROGRESS/COMPLETED semantics: never placed
// → UNASSIGNED; placed with every block COMPLETED → COMPLETED; placed with
// at least one non-COMPLETED block → IN_PROGRESS.
function derivePlanTaskStatus(taskId) {
  if (unplacedTasks.some((t) => t.taskId === taskId)) return 'UNASSIGNED'
  let hasBlock = false
  let allCompleted = true
  for (const week of weeks.values()) {
    for (const block of week.blocks) {
      if (block.taskId !== taskId) continue
      hasBlock = true
      if (block.status !== 'COMPLETED') allCompleted = false
    }
  }
  return hasBlock ? (allCompleted ? 'COMPLETED' : 'IN_PROGRESS') : 'UNASSIGNED'
}

// Mirrors projectFixtures.js's own isDueSoon (3-day horizon, never "임박" once
// COMPLETED) — a tiny, deliberate duplication rather than exporting/importing
// across the two mock stores just for this one predicate.
const PLAN_TASK_DUE_SOON_DAYS = 3
function isPlanTaskDueSoon(dueDate, status) {
  if (!dueDate || status === 'COMPLETED') return false
  const diffDays = Math.round((new Date(dueDate) - new Date()) / (24 * 60 * 60 * 1000))
  return diffDays >= 0 && diffDays <= PLAN_TASK_DUE_SOON_DAYS
}

// The SAME normalized, editable shape projectFixtures' own task records use
// (see projectApi.normalizeTask) — TaskEditModal reads either origin through
// one shape and never needs to know which store answered.
function normalizePlanTaskDetail(taskId, src) {
  const status = src.status || derivePlanTaskStatus(taskId)
  return {
    taskId: src.taskId,
    projectId: src.projectId ?? null,
    title: src.title,
    memo: src.memo ?? '', // [가정—신규] plan tasks never carried a memo field before this
    estimatedMinutes: src.estimatedMinutes,
    priority: src.priority ?? 2,
    dueDate: src.dueDate ?? null,
    status,
    // W3 fix (Thomas 리뷰 MAJOR): 이 필드는 projectApi.normalizeTask와 같은
    // categoryId(UUID)여야 한다 — `category`(문자열)로 남아 있던 탓에, plan
    // 스토어 task(`plan-task-*`, WeeklyPage "태스크 편집")를 열면 실제
    // categoryId가 있어도 TaskEditModal이 항상 "없음"으로 보였다(그 폼은
    // categoryId만 읽는다). 두 스토어가 같은 개념을 다른 필드명으로 들고
    // 있던 상태 자체가 버그였다 — project 스토어와 동일하게 맞춘다.
    categoryId: src.categoryId ?? null,
    version: src.version ?? 1, // [가정—신규] — optimistic-lock counter, first write starts it
    updatedAt: src.updatedAt ?? null, // [가정—신규]
    dueSoon: isPlanTaskDueSoon(src.dueDate, status),
  }
}

function findWeekByPlanId(weeklyPlanId) {
  for (const week of weeks.values()) {
    if (week.weeklyPlanId === weeklyPlanId) return week
  }
  return null
}

// Build a TASK block from a placement (task + target span).
function blockFromPlacement({ taskId, title, startAt, endAt }) {
  return {
    planBlockId: nextId('block'),
    blockType: 'TASK',
    title,
    tone: 'brand',
    status: 'SCHEDULED',
    taskId,
    scheduleId: null,
    startAt,
    endAt,
  }
}

function ensureWeek(weekStartISO) {
  if (!weeks.has(weekStartISO)) {
    // The current week is richly seeded (ST-F1-05's blocking-violation demo);
    // the week right before it is seeded too, but separately (AC-5's past-week
    // demo — see seedPastWeekBlocks' header). Every other week still starts
    // empty, which remains valid — nothing here requires a week to be seeded.
    let blocks = []
    if (weekStartISO === currentWeekStartISO()) blocks = seedBlocks(weekStartISO)
    else if (weekStartISO === addWeeksISO(currentWeekStartISO(), -1)) {
      blocks = seedPastWeekBlocks(weekStartISO)
    }
    weeks.set(weekStartISO, {
      weeklyPlanId: nextId('wp'),
      weekStartDate: weekStartISO,
      weekEndDate: addDaysISO(weekStartISO, 6),
      status: 'DRAFT',
      version: 1,
      blocks,
    })
  }
  return weeks.get(weekStartISO)
}

/*
  --- Validation rules (ST-F1-05, 재정합 W3) ----------------------------------

  These are REAL computations over the mock's own data, not canned issues: every
  violation the panel shows can be created and cleared by moving blocks in the
  browser, which is the only way the 3-layer display and the save gate can be
  checked by eye before BE-1's endpoint exists (the rule ENGINE itself already
  has a Java model — ValidationIssue/ValidationReport, BE PR #19/ADR-0013 — but
  no controller serves it yet).

  Coverage (rule NAMES below are the confirmed server ruleId values — see
  planApi.js's own W3 header for the full schema and the old-vs-new renumbering
  table): V1_OVERLAP·V2_FIXED_CONFLICT·V3_CAPACITY_EXCEEDED·V4_OUT_OF_AVAILABILITY
  always computable from the seeded data; V6_AFTER_DUE_DATE needs a task with a
  dueDate (backlog tasks have one — placing one after its due date fires it);
  V7_BUFFER_SHORTAGE needs two blocks closer than the buffer; V5_OUT_OF_WBS needs
  WBS project ranges, which this mock has no data for at all, so it is
  intentionally never emitted (inventing a fake WBS range would make the rule
  untestable, not testable).

  SHAPE (W3 fix — this mock used to emit a made-up `{code, targetBlockIds,
  ...params}` envelope that was never the real contract and had DRIFTED from it
  the moment BE-1 published RuleId/ValidationIssue; that gap is exactly what let
  a schema regression land silently once already this cycle, see the categories
  MAJOR Thomas caught). Every issue below now carries the REAL server fields
  (ruleId/severity BLOCK·WARNING/planBlockId/counterpartId/taskId/weekday/reason)
  PLUS two mock-only convenience fields planApi.normalizeIssue already tolerates
  as optional extras: `targetBlockIds` (lets this mock highlight MULTIPLE blocks
  — e.g. both sides of an overlap — even for a rule whose official contract only
  promises a single planBlockId) and the copy-variable params (blockTitle,
  timeRange, …) spread at top level, which is what lets violationMessages.js
  render a real Korean sentence instead of just the server's own generic
  `reason` text. A real server sends neither extra field; normalizeIssue falls
  back to planBlockId(+counterpartId)-only targeting and the bare `reason`
  string when they're absent — so this mock is a strict SUPERSET of the real
  shape, never a divergent one.
*/

// Minimum gap between consecutive blocks before "버퍼 부족" (V7_BUFFER_SHORTAGE)
// applies. ASSUMPTION: no rule document fixes this number; 10분 is the smallest
// gap that still reads as a deliberate break. Change here when the rule spec lands.
const BUFFER_MIN_MINUTES = 10

// The mock's OWN severity classification, deliberately not imported from
// violationMessages: that catalog is the CLIENT's table, and a mock standing in
// for the server must be able to disagree with it (that's exactly the case the
// client's "catalog wins for known codes" rule has to survive).
const MOCK_BLOCKING_CODES = new Set(['V1_OVERLAP', 'V2_FIXED_CONFLICT'])

// Full-English DayOfWeek name a real server would send for `weekday` (Jackson's
// default enum serialization — see planApi.js's own normalizeWeekday comment for
// why). Emitted here (rather than the FE's own 3-letter WEEKDAY_KEYS form) so
// this mock actually EXERCISES that adapter conversion in DEV instead of
// coincidentally matching it — the whole point of "mock 계약 모양 맞추기".
const WEEKDAY_KEY_TO_FULL = {
  MON: 'MONDAY',
  TUE: 'TUESDAY',
  WED: 'WEDNESDAY',
  THU: 'THURSDAY',
  FRI: 'FRIDAY',
  SAT: 'SATURDAY',
  SUN: 'SUNDAY',
}

const overlaps = (a, b) =>
  new Date(a.startAt) < new Date(b.endAt) && new Date(b.startAt) < new Date(a.endAt)

const durationOf = (b) => (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60000

const timeRangeOf = (b) =>
  `${formatMinutesLabel(minutesOfDay(b.startAt))} - ${formatMinutesLabel(minutesOfDay(b.endAt))}`

function activeWindowFor(weekdayKey) {
  return availability.find((a) => a.weekday === weekdayKey && a.isActive) ?? null
}

// Minutes of [startMin,endMin) that fall INSIDE `win` ({startMinutes,endMinutes}),
// clamped to 0 when there's no overlap (or no window at all — e.g. a weekend
// with no active availability pattern). No existing helper in
// planGeometry/planTime/planPlacement measures a clamped overlap like this
// (they test boolean overlap or search for free slots), so this is new but
// deliberately minimal — one clamp, one subtraction. Shared by V4 below.
function minutesInsideWindow(startMin, endMin, win) {
  if (!win) return 0
  return Math.max(0, Math.min(endMin, win.endMinutes) - Math.max(startMin, win.startMinutes))
}

function computeValidationIssues(weekStartISO, blocks) {
  const days = weekDays(weekStartISO)
  const issues = []
  let seq = 0
  // Emits the REAL contract envelope (validationIssueId/ruleId/severity/
  // planBlockId/counterpartId/taskId/weekday/reason) plus two mock-only
  // convenience extras — `targetBlockIds` and the spread `params` — that a real
  // server never sends and normalizeIssue only reads when present (see this
  // file's own SHAPE header paragraph above).
  const pushIssue = (
    ruleId,
    { planBlockId = null, counterpartId = null, taskId = null, weekday = null, targetBlockIds, params = {} } = {},
  ) => {
    seq += 1
    issues.push({
      validationIssueId: null,
      ruleId,
      severity: MOCK_BLOCKING_CODES.has(ruleId) ? 'BLOCK' : 'WARNING',
      planBlockId,
      counterpartId,
      taskId,
      weekday,
      // Server 문구 예시("규칙 근거 문구") 그대로 흉내 — 실제로 화면에 보이는 건
      // 이 문자열이 아니라 violationMessages.js의 params 기반 message()다; 이건
      // 그 message()가 비어 있을 경우에만 쓰이는 폴백 경로를 위한 자리표시자
      // (violationCopy 자신의 comment 참고).
      reason: `규칙 ${ruleId}에 의해 판정되었습니다`,
      id: `${ruleId}-${seq}`,
      ...(targetBlockIds !== undefined ? { targetBlockIds } : {}),
      ...params,
    })
  }

  // Only blocks that actually land in this week participate; everything below
  // groups by grid column, so an out-of-week block would have no day to compare.
  const inWeek = blocks
    .map((b) => ({ ...b, dayIndex: days.indexOf(dateOf(b.startAt)) }))
    .filter((b) => b.dayIndex >= 0)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))

  // V1_OVERLAP 일정 겹침 (차단) — every unordered pair that shares time on the
  // same day.
  for (let i = 0; i < inWeek.length; i += 1) {
    for (let j = i + 1; j < inWeek.length; j += 1) {
      const a = inWeek[i]
      const b = inWeek[j]
      if (a.dayIndex !== b.dayIndex || !overlaps(a, b)) continue
      // ADR-0013: 대표(=planBlockId)는 "쌍 중 UUID 오름차순 첫" 블록, 상대는
      // counterpartId. 이 mock의 id는 실제 UUID가 아니라 순차 문자열
      // (nextId('block'))이지만, 문자열 오름차순 비교로도 "안정적으로 대표
      // 하나를 고른다"는 계약의 실질 동작은 그대로 낸다.
      const [first, second] = a.planBlockId < b.planBlockId ? [a.planBlockId, b.planBlockId] : [b.planBlockId, a.planBlockId]
      pushIssue('V1_OVERLAP', {
        planBlockId: first,
        counterpartId: second,
        targetBlockIds: [a.planBlockId, b.planBlockId],
        params: {
          blockTitle: a.title,
          otherTitle: b.title,
          timeRange: `${WEEKDAY_LABELS_KO[a.dayIndex]} ${timeRangeOf(a)}`,
        },
      })
    }
  }

  // V2_FIXED_CONFLICT 고정 일정 충돌 (차단) — a plan block sitting on an immovable
  // fixed schedule. A fixed schedule deactivated for THIS week (ST-F1-06
  // PLAN-33) is skipped: the whole point of "이번 주만 비활성화" is that it stops
  // blocking for that week specifically, without touching any other week's
  // result.
  for (const block of inWeek) {
    const weekdayKey = WEEKDAY_KEYS[block.dayIndex]
    const startMin = minutesOfDay(block.startAt)
    const endMin = minutesOfDay(block.endAt)
    for (const fixed of fixedSchedules) {
      if (fixed.weekday !== weekdayKey) continue
      if (!isFixedActiveForWeek(fixed, weekStartISO)) continue
      if (startMin >= fixed.endMinutes || endMin <= fixed.startMinutes) continue
      pushIssue('V2_FIXED_CONFLICT', {
        planBlockId: block.planBlockId,
        // 상대는 plan_block이 아니라 fixed_schedule id다 — targetBlockIds에는
        // 절대 섞지 않는다(존재하지 않거나 엉뚱한 블록을 강조하게 된다;
        // planApi.normalizeIssue 자신의 comment 참고).
        counterpartId: fixed.fixedScheduleId,
        targetBlockIds: [block.planBlockId],
        params: {
          blockTitle: block.title,
          otherTitle: fixed.title,
          timeRange:
            `${WEEKDAY_LABELS_KO[block.dayIndex]} ` +
            `${formatMinutesLabel(fixed.startMinutes)} - ${formatMinutesLabel(fixed.endMinutes)}`,
        },
      })
    }
  }

  // V4_OUT_OF_AVAILABILITY 가용 시간 밖 배치 (경고) — TASK ONLY. ONB-03 defines
  // 가용 시간 as "태스크를 배치할 수 있는 시간" — a TASK-placement capacity, not a
  // constraint on when a SCHEDULE (a real, already-fixed appointment/meeting)
  // may sit. An evening SCHEDULE block outside the day's window is not a
  // violation of anything; it is the whole reason the window doesn't cover
  // that hour in the first place. (owner-reported: "일정은 가용시간 범위 밖에
  // 있어도 되는데 경고가 뜨네" — this rule used to fire for both block types
  // because this loop never checked blockType at all.)
  //
  // W3 계약 대조: 팀 리드가 확인한 실서버 스키마상 이 규칙은 planBlockId 없이
  // weekday만 낸다 — 이전엔 이 mock이 특정 블록(`block.planBlockId`)을 강조
  // 대상으로 냈지만, 그 동작은 여기서 사라진다(그리드 칩 하이라이트 소실 —
  // 패널 목록의 텍스트(blockTitle/timeRange)는 params로 여전히 남아 있으므로
  // "무엇이 문제인지" 자체는 계속 읽을 수 있다). PR #19가 실제로 머지되면
  // 이 rule이 정말 blockId를 안 주는지 재확인 필요 — 블록 단위 규칙이 블록
  // 참조가 없다는 게 의외라 실서버로 재검증하는 편이 안전하다.
  //
  // BE NOTE: this is the DEV mock's rule engine — computeValidationIssues here
  // is never consulted once a real server answers OP-PLAN-VALIDATE. The real
  // rule needs this SAME blockType≠SCHEDULE exclusion; flagging so the BE
  // rule-engine story picks it up.
  for (const block of inWeek) {
    if (block.blockType !== 'TASK') continue
    const win = activeWindowFor(WEEKDAY_KEYS[block.dayIndex])
    const startMin = minutesOfDay(block.startAt)
    const endMin = minutesOfDay(block.endAt)
    if (win && startMin >= win.startMinutes && endMin <= win.endMinutes) continue
    pushIssue('V4_OUT_OF_AVAILABILITY', {
      weekday: WEEKDAY_KEY_TO_FULL[WEEKDAY_KEYS[block.dayIndex]],
      params: {
        blockTitle: block.title,
        dayLabel: `${WEEKDAY_LABELS_KO[block.dayIndex]}요일`,
        timeRange: timeRangeOf(block),
      },
    })
  }

  // V3_CAPACITY_EXCEEDED 가용 시간 초과 (경고) — one issue per day whose TASK load
  // exceeds that day's TASK-PLACEMENT CAPACITY. Day-level by nature (a total,
  // not any one block's own placement), so — unlike V4_OUT_OF_AVAILABILITY
  // above — this rule never had a natural single-block target even before W3;
  // weekday-only matches the real contract cleanly here.
  //
  // 가용 창(WINDOW, 09–18) and 가용 시간(CAPACITY, "얼마나 태스크에 쓸 수 있는가")
  // are NOT the same thing — that's the distinction this rule turns on
  // (ONB-03 · owner decision). The window is a fixed span; the capacity is what
  // is LEFT of it after a personal SCHEDULE inside it has already claimed some
  // (a 2-hour lunch meeting inside a 9-hour window leaves only 7 hours a TASK
  // could ever occupy).
  //   capacity = window length − SCHEDULE minutes INSIDE the window (clipped
  //              via minutesInsideWindow, reused as-is — its signature already
  //              fits a SCHEDULE block the same as a TASK block).
  //   planned  = TASK minutes IN FULL, regardless of where they sit. A task
  //              pushed out past the window is still planned work for that
  //              day — that is exactly the "초과" this rule exists to catch,
  //              so clipping it to the window would hide the one case that
  //              matters most.
  //
  // PRIOR VERSION (superseded): clipped EVERY block — TASK included — to the
  // window and compared against the raw window length. That made this rule
  // UNFIRABLE in practice: two non-overlapping blocks' in-window minutes can
  // never exceed the window's own length (their clipped sum is bounded by the
  // window itself), and the only way to exceed it is to overlap, which
  // V1_OVERLAP (차단) already reports. Do not go back to that shape.
  //
  // capacity is clamped to >= 0 (Math.max) — a SCHEDULE that fills or exceeds
  // the window on its own (an all-day commitment) leaves NEGATIVE room, not
  // negative capacity; any TASK placed that day is then, correctly, entirely
  // "초과".
  //
  // BE NOTE: same as the rules above/below — computeValidationIssues is the
  // DEV mock's rule engine only; the real rule needs this identical 창≠용량
  // distinction (capacity = window minus in-window SCHEDULE time; load = full
  // TASK time).
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayBlocks = inWeek.filter((b) => b.dayIndex === dayIndex)
    if (dayBlocks.length === 0) continue
    const win = activeWindowFor(WEEKDAY_KEYS[dayIndex])
    const windowLength = win ? win.endMinutes - win.startMinutes : 0
    const scheduleMinutesInWindow = dayBlocks
      .filter((b) => b.blockType === 'SCHEDULE')
      .reduce(
        (sum, b) => sum + minutesInsideWindow(minutesOfDay(b.startAt), minutesOfDay(b.endAt), win),
        0,
      )
    const capacity = Math.max(0, windowLength - scheduleMinutesInWindow)

    // A day with NO active window (weekend, or a weekday toggled off) now
    // gets capacity 0 — a genuine behavior change from the prior version,
    // where such a day was silent. Placing a TASK there is a real 초과 (its
    // whole duration is over a 0-capacity day) AND is separately caught by
    // V4_OUT_OF_AVAILABILITY (TASK-only, "가용 시간 밖 배치"): the two fire
    // TOGETHER on a windowless day, one naming the day's total, the other
    // naming the specific placement. This mirrors a pattern the panel already
    // tolerates elsewhere (one block can carry several simultaneous issues —
    // see WeeklyPage.jsx's violationsByBlockId), so it is left as two honest,
    // differently-worded warnings rather than suppressing either.
    const taskBlocks = dayBlocks.filter((b) => b.blockType === 'TASK')
    const planned = taskBlocks.reduce((sum, b) => sum + durationOf(b), 0)
    if (planned <= capacity) continue
    pushIssue('V3_CAPACITY_EXCEEDED', {
      weekday: WEEKDAY_KEY_TO_FULL[WEEKDAY_KEYS[dayIndex]],
      params: {
        dayLabel: `${WEEKDAY_LABELS_KO[dayIndex]}요일`,
        overMinutes: Math.round(planned - capacity),
      },
    })
  }

  // V6_AFTER_DUE_DATE 마감일 이후 배치 (경고) — the task's own dueDate vs the day
  // it sits on. Block-level (unlike V3/V4 above) — planBlockId AND taskId both
  // present, matching ValidationIssue.java's own comment ("요일 단위 규칙에서는
  // planBlockId·taskId가 null" implies a BLOCK-level rule like this one carries
  // both).
  for (const block of inWeek) {
    const task = block.taskId ? placedTaskData.get(block.taskId) : null
    const placedDate = dateOf(block.startAt)
    if (!task?.dueDate || placedDate <= task.dueDate) continue
    pushIssue('V6_AFTER_DUE_DATE', {
      planBlockId: block.planBlockId,
      taskId: block.taskId ?? null,
      targetBlockIds: [block.planBlockId],
      params: {
        blockTitle: block.title,
        dueDate: task.dueDate,
        placedDate,
      },
    })
  }

  // V7_BUFFER_SHORTAGE 버퍼 부족 (경고) — consecutive same-day blocks with a gap
  // under the buffer. A gap of EXACTLY 0 (back-to-back, no breathing room at
  // all) is the WORST case of "버퍼 부족", not an exemption from it — it must
  // warn same as any gap under BUFFER_MIN_MINUTES (owner-reported: 5분 간격은
  // 경고되는데 0분은 안 뜨는 건 규칙이 앞뒤가 안 맞았음). Only a NEGATIVE gap is
  // skipped here — that is a genuine overlap, already reported as the 차단
  // V1_OVERLAP above; this rule has nothing further to add about it as a mere
  // warning.
  //
  // ADR-0013's "쌍 규칙"(counterpartId) convention names ONLY V1_OVERLAP/
  // V2_FIXED_CONFLICT — this rule is NOT among them, so it gets a single
  // representative `planBlockId` (the later/crowding block), no counterpartId.
  // `targetBlockIds` still carries BOTH blocks as a mock-only convenience (the
  // review panel/grid can keep highlighting the whole crowded pair in DEV);
  // a real server, sending only the single planBlockId, would highlight one.
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayBlocks = inWeek.filter((b) => b.dayIndex === dayIndex)
    for (let i = 1; i < dayBlocks.length; i += 1) {
      const prev = dayBlocks[i - 1]
      const next = dayBlocks[i]
      const gap = minutesOfDay(next.startAt) - minutesOfDay(prev.endAt)
      if (gap < 0 || gap >= BUFFER_MIN_MINUTES) continue
      pushIssue('V7_BUFFER_SHORTAGE', {
        planBlockId: next.planBlockId,
        targetBlockIds: [prev.planBlockId, next.planBlockId],
        params: {
          blockTitle: prev.title,
          otherTitle: next.title,
          gapMinutes: gap,
        },
      })
    }
  }

  return issues
}

/*
  --- Replan alternatives (ST-F1-07) -----------------------------------------

  Like the validation rules above, these are REAL computations over the mock's
  own block/availability/fixed-schedule data, not canned responses — every
  alternative can be produced and compared by moving blocks in the browser,
  which is the only way "4안 비교" is checkable before BE-1's rule engine
  exists. Each strategy reuses the SAME primitives the rest of the app already
  trusts (findFirstFreeSlot, byPriorityThenDue's sibling comparator, the V1/V2
  blocking-issue detector) rather than inventing separate placement math.

  A fixed schedule is an immovable constraint here exactly as it is for V2: it
  never appears in `week.blocks` (fixed schedules are not plan_blocks — see the
  seedFixedSchedules comment), so every strategy below builds its own "occupied"
  spans list by ADDING the week's active fixed-schedule spans to whatever plan
  blocks it is placing around. Only a TASK block is ever moved; a SCHEDULE
  block is a personal commitment the user placed on purpose (ST-F1-04) and is
  left untouched, exactly like a fixed schedule.
*/

// This week's active fixed schedules as {startAt,endAt} spans, so they can be
// added to a placement search's "occupied" list the same way plan blocks are.
// A schedule deactivated for this week (PLAN-33) contributes nothing — the
// whole point of "이번 주만 비활성화" is that it stops constraining this week.
function fixedScheduleSpans(weekStartISO) {
  const days = weekDays(weekStartISO)
  const spans = []
  for (const fixed of fixedSchedules) {
    if (!isFixedActiveForWeek(fixed, weekStartISO)) continue
    const dayIndex = WEEKDAY_KEYS.indexOf(fixed.weekday)
    if (dayIndex < 0) continue
    spans.push({
      startAt: composeTimestamp(days[dayIndex], fixed.startMinutes),
      endAt: composeTimestamp(days[dayIndex], fixed.endMinutes),
    })
  }
  return spans
}

// RB-PLAN-03 최소 변경안 — move ONLY the blocks currently named by a 차단
// violation (V1_OVERLAP 겹침 / V2_FIXED_CONFLICT 고정 일정 충돌) to the NEXT free
// slot after their current position ("인접 가용 시간"); every other block is
// untouched. Returns null when there is nothing blocking to fix — a real "no
// change needed" result, not a failure.
function buildMinimalChange(week, blocks) {
  const days = weekDays(week.weekStartDate)
  const fixedSpans = fixedScheduleSpans(week.weekStartDate)
  const issues = computeValidationIssues(week.weekStartDate, blocks)
  // W3 field rename: `code` → `ruleId` (this issue shape now matches the real
  // ValidationIssue contract — see computeValidationIssues' own SHAPE header).
  // `targetBlockIds` is still the mock-only convenience list (both rules here
  // are pair-rules that always populate it) — never empty for V1_OVERLAP/
  // V2_FIXED_CONFLICT, so this strategy's own "which blocks to move" logic is
  // unaffected by V3/V4's new weekday-only (blockless) shape above.
  const conflictingIds = new Set(
    issues.filter((i) => MOCK_BLOCKING_CODES.has(i.ruleId)).flatMap((i) => i.targetBlockIds ?? []),
  )
  if (conflictingIds.size === 0) return null

  let working = blocks.map((b) => ({ ...b }))
  let movedCount = 0
  for (const blockId of conflictingIds) {
    const block = working.find((b) => b.planBlockId === blockId)
    if (!block || block.blockType !== 'TASK') continue // only a TASK block is this strategy's to move
    const dayIndex = days.indexOf(dateOf(block.startAt))
    if (dayIndex < 0) continue
    // durationOf reads an ALREADY-COMMITTED block's own span, not a task's raw
    // estimate — every block this strategy can ever see got its span through
    // clampBlockSpan/snapDuration at creation (createBlock/autoPlace/
    // commitBatch, all above), so `duration` here is already a 5-minute
    // multiple by construction and `startMin + duration` below stays aligned
    // without re-snapping. Not true of a fresh estimate (see taskApi's
    // normalizeTask) — this is why replan strategies don't need their own
    // clampBlockSpan call the way a NEW placement does.
    const duration = durationOf(block)
    const occupied = [
      ...working.filter((b) => b.planBlockId !== blockId).map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
      ...fixedSpans,
    ]
    const slot = findFirstFreeSlot({
      days,
      availability,
      blocks: occupied,
      durationMin: duration,
      fromDayIndex: dayIndex,
      fromMin: minutesOfDay(block.startAt),
    })
    if (!slot) continue
    const startAt = composeTimestamp(days[slot.dayIndex], slot.startMin)
    const endAt = composeTimestamp(days[slot.dayIndex], slot.startMin + duration)
    working = working.map((b) => (b.planBlockId === blockId ? { ...b, startAt, endAt } : b))
    movedCount += 1
  }
  if (movedCount === 0) return null

  return {
    strategyType: 'MINIMAL_CHANGE',
    changeSummary: `충돌 항목 ${movedCount}건만 인접한 가용 시간으로 옮깁니다`,
    recommendationReason: '기존 배치를 최대한 유지하면서 충돌만 해소합니다',
    // This strategy's OWN definition of "better" is "fewer moves" — the inverse
    // of the other two, where a higher score means more improved.
    score: 1 / (1 + movedCount),
    proposedBlocks: working,
  }
}

// RB-PLAN-04 마감 우선안 — re-lay every TASK block out in due-date order
// (byDueThenPriority), earliest deadline claiming the earliest free slot.
// SCHEDULE blocks are anchors (never moved); a task that already sits at the
// best slot available to it simply doesn't move.
function buildDeadlineFirst(week, blocks) {
  const days = weekDays(week.weekStartDate)
  const fixedSpans = fixedScheduleSpans(week.weekStartDate)
  const taskBlocks = blocks.filter((b) => b.blockType === 'TASK')
  const anchored = blocks.filter((b) => b.blockType !== 'TASK')
  if (taskBlocks.length === 0) return null

  const ordered = [...taskBlocks].sort((a, b) => {
    const taskA = a.taskId ? placedTaskData.get(a.taskId) : null
    const taskB = b.taskId ? placedTaskData.get(b.taskId) : null
    return byDueThenPriority(
      { dueDate: taskA?.dueDate ?? null, priority: taskA?.priority ?? a.priority },
      { dueDate: taskB?.dueDate ?? null, priority: taskB?.priority ?? b.priority },
    )
  })

  let occupied = [...anchored.map((b) => ({ startAt: b.startAt, endAt: b.endAt })), ...fixedSpans]
  const placed = []
  let movedCount = 0
  for (const block of ordered) {
    // durationOf(block) is already 5-aligned by construction — see
    // buildMinimalChange's own comment on this same pattern, above.
    const duration = durationOf(block)
    const slot = findFirstFreeSlot({ days, availability, blocks: occupied, durationMin: duration })
    if (!slot) {
      // No room to improve this one — leave it exactly where it was rather than
      // dropping it from the plan.
      placed.push(block)
      occupied.push({ startAt: block.startAt, endAt: block.endAt })
      continue
    }
    const startAt = composeTimestamp(days[slot.dayIndex], slot.startMin)
    const endAt = composeTimestamp(days[slot.dayIndex], slot.startMin + duration)
    if (startAt !== block.startAt || endAt !== block.endAt) movedCount += 1
    placed.push({ ...block, startAt, endAt })
    occupied.push({ startAt, endAt })
  }
  if (movedCount === 0) return null

  return {
    strategyType: 'DEADLINE_FIRST',
    changeSummary: `마감일이 가까운 태스크 ${movedCount}건을 앞쪽 가용 슬롯으로 옮깁니다`,
    recommendationReason: '마감일 준수 가능성을 높이는 방향으로 재배치합니다',
    score: movedCount,
    proposedBlocks: [...anchored, ...placed],
  }
}

// RB-PLAN-05 작업 분산안 — while some day plans more than its availability
// window (the same over-capacity test V4 uses) and some OTHER day still has
// spare room, move the smallest TASK block on the worst over-capacity day into
// the day with the most spare room, one block per iteration. Bounded by the
// number of TASK blocks so an infeasible week (nowhere has room) can't loop.
function buildWorkloadBalance(week, blocks) {
  const days = weekDays(week.weekStartDate)
  const fixedSpans = fixedScheduleSpans(week.weekStartDate)
  let working = blocks.map((b) => ({ ...b }))

  const dayLoad = (dayIndex) => {
    const dayISO = days[dayIndex]
    const dayBlocks = working.filter((b) => dateOf(b.startAt) === dayISO)
    const win = availabilityForColumn(dayIndex, availability)
    const capacity = win ? win.endMinutes - win.startMinutes : 0
    const planned = dayBlocks.reduce((sum, b) => sum + durationOf(b), 0)
    return { planned, capacity, over: planned - capacity }
  }

  let movedCount = 0
  const maxIterations = working.filter((b) => b.blockType === 'TASK').length
  for (let iter = 0; iter < maxIterations; iter += 1) {
    const loads = Array.from({ length: 7 }, (_, i) => ({ dayIndex: i, ...dayLoad(i) }))
    const overDay = loads.filter((d) => d.over > 0).sort((a, b) => b.over - a.over)[0]
    if (!overDay) break
    const underDay = loads
      .filter((d) => d.capacity - d.planned > 0)
      .sort((a, b) => b.capacity - b.planned - (a.capacity - a.planned))[0]
    if (!underDay) break

    const dayISO = days[overDay.dayIndex]
    // The smallest block that still fits the under-day's remaining room — the
    // least disruptive single move available this iteration.
    const candidate = working
      .filter((b) => b.blockType === 'TASK' && dateOf(b.startAt) === dayISO)
      .filter((b) => durationOf(b) <= underDay.capacity - underDay.planned)
      .sort((a, b) => durationOf(a) - durationOf(b))[0]
    if (!candidate) break

    const occupied = [
      ...working
        .filter((b) => b.planBlockId !== candidate.planBlockId)
        .map((b) => ({ startAt: b.startAt, endAt: b.endAt })),
      ...fixedSpans,
    ]
    const slot = findFirstFreeSlot({
      days,
      availability,
      blocks: occupied,
      durationMin: durationOf(candidate),
      fromDayIndex: underDay.dayIndex,
      fromMin: 0,
    })
    // Only accept a slot that actually landed on the intended under-capacity
    // day — findFirstFreeSlot wraps to OTHER days once that day has no room,
    // which would silently defeat the balancing intent (still legal, just not
    // what this iteration was trying to do).
    if (!slot || slot.dayIndex !== underDay.dayIndex) break

    // durationOf(candidate) is already 5-aligned by construction — see
    // buildMinimalChange's own comment on this same pattern, above.
    const startAt = composeTimestamp(days[slot.dayIndex], slot.startMin)
    const endAt = composeTimestamp(days[slot.dayIndex], slot.startMin + durationOf(candidate))
    working = working.map((b) =>
      b.planBlockId === candidate.planBlockId ? { ...b, startAt, endAt } : b,
    )
    movedCount += 1
  }
  if (movedCount === 0) return null

  return {
    strategyType: 'WORKLOAD_BALANCE',
    changeSummary: `과부하 요일의 태스크 ${movedCount}건을 여유 있는 요일로 분산합니다`,
    recommendationReason: '하루 가용 시간 초과를 줄이는 방향으로 재배치합니다',
    score: movedCount,
    proposedBlocks: working,
  }
}

function buildReplanOption(week, blocks, strategyType) {
  switch (strategyType) {
    case 'MINIMAL_CHANGE':
      return buildMinimalChange(week, blocks)
    case 'DEADLINE_FIRST':
      return buildDeadlineFirst(week, blocks)
    case 'WORKLOAD_BALANCE':
      return buildWorkloadBalance(week, blocks)
    default:
      return null
  }
}

// replan_option_id -> { ...option, weeklyPlanId }. The mock has no persistent
// replan_options table, so a generated option is kept here just long enough for
// a later `selectReplanOption` call to look its proposedBlocks back up by id —
// mirroring what a real server would do internally between the two endpoints.
const replanOptionsById = new Map()

function computeDerived(week) {
  const totalPlannedMinutes = week.blocks.reduce((sum, b) => {
    const mins = (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60000
    return sum + mins
  }, 0)
  // Denormalize a SCHEDULE block's owning-schedule fields (memo·estimatedMinutes·
  // priority) onto the block so 일정 편집 (PLAN-17) can prefill without a GET.
  const blocks = week.blocks.map((b) => {
    if (b.blockType === 'SCHEDULE' && b.scheduleId && schedulesById.has(b.scheduleId)) {
      const s = schedulesById.get(b.scheduleId)
      return { ...b, memo: s.memo, estimatedMinutes: s.estimatedMinutes, priority: s.priority }
    }
    // Attach the project link for a placed task (PLAN-12); seeded tasks have none.
    if (b.blockType === 'TASK' && b.taskId && placedTaskData.has(b.taskId)) {
      const t = placedTaskData.get(b.taskId)
      return { ...b, projectId: t.projectId ?? null, projectName: t.projectName ?? null }
    }
    return b
  })
  // The week payload's `validation` summary is the counts the header shows BEFORE
  // the first dry-run answers, so it runs the same rules the dry-run does — a
  // placeholder here would make the badge briefly lie on every week change.
  const issues = computeValidationIssues(week.weekStartDate, blocks)
  // W3 field rename: `code` → `ruleId`, values re-keyed to the real server
  // rule names (see computeValidationIssues' own SHAPE header) — this filter
  // (and buildMinimalChange's own copy above) must read the SAME field name
  // MOCK_BLOCKING_CODES/pushIssue now use, or this badge silently freezes at
  // 0/0 regardless of what the rules actually find.
  const blockingCodes = issues.filter((i) => MOCK_BLOCKING_CODES.has(i.ruleId))
  return {
    ...week,
    blocks,
    totalPlannedMinutes,
    // Unplaced count = never-placed backlog + partially-placed remainders (A4).
    unplacedCount: unplacedTasks.length + placedRemainders().length,
    validation: {
      blockCount: blockingCodes.length,
      warningCount: issues.length - blockingCodes.length,
    },
  }
}

export const mockBackend = {
  // GET /weekly-plans?weekStartDate= — answers with the REAL WeeklyPlanView
  // envelope shape (`{ plan: {...}, blocks: [...] }`, with `unplacedCount`/
  // `validation` alongside `blocks` at the top level, per openapi.yaml — a
  // live server confirmed 2026-08-28), not a flat object. Before this change
  // the mock's own shape was flat, so DEV never actually exercised
  // `normalizeWeek`'s envelope-unwrap path — every `weeklyPlanId` read in
  // DEV happened to work by ACCIDENT (flat `w.weeklyPlanId` existed), while
  // the same code silently read `undefined` against a real server (`POST
  // /weekly-plans/undefined/blocks`, `E-COM-001`). Matching the real
  // envelope here is what makes that class of bug reachable in DEV going
  // forward — same "mock이 계약 모양을 흉내 낸다" rule
  // `computeValidationIssues`'s own header already follows for weekday.
  // `computeDerived` itself keeps its OWN flat return shape internally
  // (saveWeek/getReplanOptions below still read `.totalPlannedMinutes`/
  // `.blocks` off it directly) — only THIS call site reshapes it into the
  // wire envelope `planApi.normalizeWeek` expects.
  async getWeek(weekStartISO) {
    await delay(60)
    const derived = computeDerived(ensureWeek(weekStartISO))
    return {
      plan: {
        weeklyPlanId: derived.weeklyPlanId,
        weekStartDate: derived.weekStartDate,
        weekEndDate: derived.weekEndDate,
        status: derived.status,
        version: derived.version,
        totalPlannedMinutes: derived.totalPlannedMinutes,
      },
      blocks: derived.blocks,
      unplacedCount: derived.unplacedCount,
      validation: derived.validation,
    }
  },

  async getAvailability() {
    await delay(60)
    return availability
  },

  // GET /fixed-schedules?status=ACTIVE — ST-F1-06. `weekStartISO` is a mock-only
  // extra argument (see fixedScheduleApi.js's ASSUMPTION note): the real 07번
  // 명세서 GET has no weekly concept at all, so this is where that gap is
  // papered over — `activeThisWeek` is computed fresh per call from the week
  // exception store rather than stored on the schedule itself.
  async getFixedSchedules(weekStartISO) {
    await delay(60)
    return {
      fixedSchedules: fixedSchedules.map((f) => ({
        ...f,
        activeThisWeek: isFixedActiveForWeek(f, weekStartISO),
      })),
    }
  },

  // POST /fixed-schedules/{id}/week-exceptions — PLAN-33 이번 주만 비활성화. The
  // contract marks this non-idempotent (api-contracts.md §2.2), but a Set makes a
  // repeat call for the SAME week a harmless no-op here — there is no meaningful
  // "second" deactivation of a week that is already deactivated.
  async addFixedWeekException(fixedScheduleId, weekStartISO) {
    await delay()
    if (!weekExceptionsByFixedId.has(fixedScheduleId)) {
      weekExceptionsByFixedId.set(fixedScheduleId, new Set())
    }
    weekExceptionsByFixedId.get(fixedScheduleId).add(weekStartISO)
    return { message: 'CREATED' }
  },

  // DELETE /fixed-schedules/{id}/week-exceptions/{weekStartDate} — PLAN-34 다시
  // 활성화. Idempotent per the contract: deleting an exception that is already
  // gone (e.g. a stale UI retry) is treated as success, not a 404.
  async removeFixedWeekException(fixedScheduleId, weekStartISO) {
    await delay()
    weekExceptionsByFixedId.get(fixedScheduleId)?.delete(weekStartISO)
    return { message: 'DELETED' }
  },

  // GET /fixed-schedules (ST-F1-12 고정 일정 관리 — no weekStartDate: the
  // settings LIST is week-agnostic, unlike ST-F1-06's plan-grid read above).
  // `hasConflict` is a settings-only convenience the 07 명세서 doesn't promise;
  // it is derived here from the SAME overlap scan conflict-previews uses, so
  // the list badge and the preview dialog can never disagree with each other.
  async getFixedSchedulesAll() {
    await delay(60)
    return {
      fixedSchedules: fixedSchedules.map((f) => ({
        ...f,
        hasConflict: scanFixedConflicts(f.weekday, f.startMinutes, f.endMinutes).length > 0,
      })),
    }
  },

  // POST /fixed-schedules (ST-B2-12 생성). MANUAL source, ACTIVE status,
  // version 1 — matches every other create path's fresh-row shape.
  async createFixedSchedule(body) {
    await delay()
    const created = {
      fixedScheduleId: nextId('fixed'),
      title: body.title,
      weekday: body.weekday,
      startMinutes: body.startMinutes,
      endMinutes: body.endMinutes,
      effectiveFrom: body.effectiveFrom ?? null,
      effectiveTo: body.effectiveTo ?? null,
      source: 'MANUAL',
      status: 'ACTIVE',
      version: 1,
    }
    fixedSchedules.push(created)
    return created
  },

  // PATCH /fixed-schedules/{id} (ST-B2-12 편집). Same optimistic-lock shape
  // as projectFixtures/planFixtures' own updateTask: a version mismatch
  // throws an AppError-shaped rejection directly (withDevFallback only
  // catches a NETWORK failure — whatever this throws IS what the caller's
  // onError receives). AC-4 "MANUAL status 항상 ACTIVE — PATCH로 status 변경
  // 시도 422": any attempt to change status on a MANUAL row is rejected before
  // the version check even runs (a 422 is a request-shape rejection, not a
  // conflict — checking it first matches that ordering).
  async updateFixedSchedule(fixedScheduleId, patch) {
    await delay()
    const existing = fixedSchedules.find((f) => f.fixedScheduleId === fixedScheduleId)
    if (!existing) {
      const err = new Error('mock: fixed schedule not found')
      err.status = 404
      throw err
    }
    if (patch.status != null && patch.status !== existing.status && existing.source === 'MANUAL') {
      const err = new Error('mock: MANUAL fixed schedule status is always ACTIVE')
      // Thomas 리뷰 MEDIUM fix: was E-COM-009, which §2 공통 불변식 문서가
      // 5분 배수 위반 하나에만 1:1로 예약해 둔 코드다 — 이 실패는 5분 단위와
      // 무관한 별개 검증(상태 변경 자체가 MANUAL 행에서 금지)이라 그 코드를
      // 빌려 쓰면 코드↔의미 1:1이 깨진다. [가정-확장] E-FIX-001 — 07 API
      // 명세서에 없는 코드, 이 mock이 만든 자리표시자다(현재 UI에서 이
      // 경로로 status를 보내는 호출부가 없어 dead path지만, 실제로 호출될
      // 때를 대비해 의미를 정확히 남겨 둔다).
      err.code = 'E-FIX-001'
      err.status = 422
      throw err
    }
    if (patch.version != null && patch.version !== existing.version) {
      const err = new Error('mock: fixed schedule version conflict')
      err.code = 'E-COM-006'
      err.status = 409
      err.details = { latest: { ...existing } }
      throw err
    }
    Object.assign(existing, {
      title: patch.title ?? existing.title,
      weekday: patch.weekday ?? existing.weekday,
      startMinutes: patch.startMinutes ?? existing.startMinutes,
      endMinutes: patch.endMinutes ?? existing.endMinutes,
      effectiveFrom: patch.effectiveFrom !== undefined ? patch.effectiveFrom : existing.effectiveFrom,
      effectiveTo: patch.effectiveTo !== undefined ? patch.effectiveTo : existing.effectiveTo,
      version: existing.version + 1,
    })
    return existing
  },

  // DELETE /fixed-schedules/{id} (ST-B2-12 AC-3: week_exceptions CASCADE).
  async deleteFixedSchedule(fixedScheduleId) {
    await delay()
    const idx = fixedSchedules.findIndex((f) => f.fixedScheduleId === fixedScheduleId)
    if (idx >= 0) fixedSchedules.splice(idx, 1)
    weekExceptionsByFixedId.delete(fixedScheduleId)
    return { message: 'DELETED' }
  },

  // POST /fixed-schedules/conflict-previews (ST-B2-12 AC-1, dry-run — no
  // persistence). `excludeFixedScheduleId` lets an EDIT preview skip the row
  // being edited (unused by the scan itself today — it compares against plan
  // BLOCKS, never other fixed schedules — kept in the signature so the real
  // endpoint's request shape is already right when BE lands it).
  async previewFixedScheduleConflicts({ weekday, startMinutes, endMinutes }) {
    await delay()
    const affectedWeeks = scanFixedConflicts(weekday, startMinutes, endMinutes)
    return { affectedWeeks, hasConflict: affectedWeeks.length > 0 }
  },

  async patchBlock(planBlockId, patch) {
    await delay()
    for (const week of weeks.values()) {
      const block = week.blocks.find((b) => b.planBlockId === planBlockId)
      if (block) {
        Object.assign(block, patch)
        // A block whose new start lands in a different week migrates stores
        // (PLAN-20 week-boundary move). The caller passes the target week key.
        if (patch.__targetWeek && patch.__targetWeek !== week.weekStartDate) {
          week.blocks = week.blocks.filter((b) => b.planBlockId !== planBlockId)
          const target = ensureWeek(patch.__targetWeek)
          delete block.__targetWeek
          target.blocks.push(block)
        } else {
          delete block.__targetWeek
        }
        return { planBlockId, ...patch }
      }
    }
    // Soft no-op for an unknown id (e.g. an optimistic temp-id acted on before it
    // reconciled) — avoids a spurious "요청을 처리하지 못했습니다" on a benign race.
    return { planBlockId, ...patch }
  },

  async putAvailabilities(patterns) {
    await delay()
    availability = patterns
    return patterns
  },

  // GET /tasks?status=UNASSIGNED — the unplaced backlog, optionally filtered to a
  // project (PROJ-15/19 entry). Returns the `{ tasks }` envelope body shape.
  async getUnplacedTasks(projectId) {
    await delay(60)
    // Never-placed backlog + remainders of partially-placed tasks (A4).
    const all = [...unplacedTasks, ...placedRemainders()]
    const tasks = projectId ? all.filter((t) => t.projectId === projectId) : all
    return { tasks: tasks.map((t) => ({ ...t })) }
  },

  // POST /weekly-plans/{id}/blocks (blockType=TASK) — place one task. Adds the
  // block to its week and drops the task from the backlog.
  async createBlock(weeklyPlanId, body) {
    await delay()
    const week = findWeekByPlanId(weeklyPlanId)
    if (!week) throw new Error(`mock: plan ${weeklyPlanId} not found`)
    const block = blockFromPlacement({
      taskId: body.taskId,
      title: body.title,
      startAt: body.startAt,
      endAt: body.endAt,
    })
    week.blocks.push(block)
    rememberPlaced(body.taskId)
    unplacedTasks = unplacedTasks.filter((t) => t.taskId !== body.taskId)
    return { planBlockId: block.planBlockId }
  },

  // POST /weekly-plans/{id}/auto-placements — DRAFT only. Greedily lays the
  // backlog into free slots without mutating any store; the client holds the
  // result as a draft overlay until [적용] commits it.
  //
  // `priorityType` (owner/lead review, W2 API alignment): RB-PLAN-01's OWN
  // toast copy ("우선순위·마감일 순으로 배치 중입니다", WeeklyPage's
  // handleAutoPlace) is the one ordering this button has ever promised, so
  // byPriorityThenDue is the DEFAULT for any value this doesn't recognize —
  // including no argument at all, which is what every current caller sends.
  // Only the ONE literal this codebase already gave a meaning to elsewhere
  // (`'DEADLINE_FIRST'`, replanStrategies.js's RB-PLAN-04 "마감 우선안") flips
  // to the inverse ordering — reusing that SAME comparator rather than a
  // second implementation of "due date first", so a future caller that wants
  // that ordering here gets identical behavior to the replan alternative of
  // the same name. Previously this parameter was accepted by taskApi's
  // signature but silently DROPPED here (JS just ignores an extra arg) — the
  // real risk once a real server actually reads this field is that it starts
  // reordering placements the mock never did, a "조용히 바뀌는 정렬" the owner
  // flagged; branching on it now, even before the real contract is settled,
  // means dev-mode behavior can no longer silently diverge from it.
  async autoPlace(weeklyPlanId, priorityType) {
    await delay(220) // a visible "배치 중…" beat, without feeling stuck
    const week = findWeekByPlanId(weeklyPlanId)
    if (!week) throw new Error(`mock: plan ${weeklyPlanId} not found`)
    const days = weekDays(week.weekStartDate)
    // occupied grows as we draft, so drafts don't overlap each other or real blocks.
    const occupied = week.blocks.map((b) => ({ startAt: b.startAt, endAt: b.endAt }))
    const compare = priorityType === 'DEADLINE_FIRST' ? byDueThenPriority : byPriorityThenDue
    const placements = []
    const unplaced = []
    for (const task of [...unplacedTasks].sort(compare)) {
      // snapDuration here is a backstop, not the primary fix — taskApi's
      // normalizeTask already snaps every task's estimate at the read
      // boundary, but this mock's OWN seed/remainder data feeds `unplacedTasks`
      // too (never round-tripped through that adapter), so this call site
      // stays defensive rather than trusting every source to already comply.
      const duration = snapDuration(task.estimatedMinutes ?? 60)
      const slot = findFirstFreeSlot({ days, availability, blocks: occupied, durationMin: duration })
      if (!slot) {
        unplaced.push({ ...task, reason: '이번 주 남은 가용 시간에 맞는 빈 구간이 없습니다' })
        continue
      }
      // clampBlockSpan (not a raw `+ duration`): findFirstFreeSlot already
      // guarantees `duration` fits within the day's window, so the midnight
      // clamp never actually fires here — kept anyway so this call site
      // can't silently diverge from the one real rule (start/end always
      // built through this same helper) if that guarantee ever changes.
      const { startMin, endMin } = clampBlockSpan(slot.startMin, duration)
      const startAt = composeTimestamp(days[slot.dayIndex], startMin)
      const endAt = composeTimestamp(days[slot.dayIndex], endMin)
      // 🔴 계약(openapi PlanBlockInput)의 shape 그대로 — blockType 포함, title 없음.
      //    title 은 서버가 주지 않는다(taskId 로 화면이 잇는다).
      placements.push({ blockType: 'TASK', taskId: task.taskId, startAt, endAt })
      occupied.push({ startAt, endAt })
    }
    // 🔴 이 목이 오래도록 `{ placements, unplaced }` 라는 **계약에 없는 이름**을
    //    돌려줬고, 어댑터가 거기에 맞춰져 실서버에서만 조용히 깨졌다(2026-08-28).
    //    목은 클라이언트가 아니라 **계약**을 흉내내야 한다 — 서버와 같은 이름·같은
    //    모양으로 돌려준다. unplaced 도 태스크 객체가 아니라 UUID 배열이다.
    return {
      proposedBlocks: placements,
      unplacedTaskIds: unplaced.map((t) => t.taskId),
      reason: '우선순위·마감일·예상시간 순으로 가용 시간에 채웠습니다(first-fit).',
    }
  },

  // POST /weekly-plans/{id}/block-batches — commit an applied auto-place draft.
  async commitBatch(weeklyPlanId, placements) {
    await delay()
    const week = findWeekByPlanId(weeklyPlanId)
    if (!week) throw new Error(`mock: plan ${weeklyPlanId} not found`)
    const placedIds = new Set()
    for (const p of placements ?? []) {
      week.blocks.push(blockFromPlacement(p))
      rememberPlaced(p.taskId)
      placedIds.add(p.taskId)
    }
    unplacedTasks = unplacedTasks.filter((t) => !placedIds.has(t.taskId))
    return { placedCount: placedIds.size }
  },

  // PATCH /tasks/{taskId}/status — PLAN-13/14 완료/미완료. Mirrors onto every
  // block of the task so the grid reflects completion (block.status).
  async setTaskStatus(taskId, status) {
    await delay(80)
    for (const week of weeks.values()) {
      for (const block of week.blocks) {
        if (block.taskId === taskId) block.status = status
      }
    }
    return { message: 'STATUS_UPDATED' }
  },

  // GET /tasks/{taskId}, `plan-task-*` half ([가정—신규], ST-F1-09 owner
  // follow-up) — see findPlanTaskSource's own header for the full contract.
  // projectApi.getTask routes here by id prefix; a `task-*` id never reaches
  // this method at all.
  async getTask(taskId) {
    await delay(60)
    const src = findPlanTaskSource(taskId)
    if (!src) {
      const err = new Error('mock: plan task not found')
      err.status = 404
      throw err
    }
    return normalizePlanTaskDetail(taskId, src)
  },

  // PATCH /tasks/{taskId}, `plan-task-*` half ([가정—신규], ST-F1-09 owner
  // follow-up). Same optimistic-lock contract as projectFixtures'
  // updateTask (version mismatch → E-COM-006 + details.latest), so
  // ConflictOverlay/"재시도" work identically regardless of which store
  // answered.
  async updateTask(taskId, body) {
    await delay()
    const src = findPlanTaskSource(taskId)
    if (!src) {
      const err = new Error('mock: plan task not found')
      err.status = 404
      throw err
    }
    const currentVersion = src.version ?? 1
    if (body.version != null && body.version !== currentVersion) {
      const err = new Error('mock: plan task version conflict')
      err.code = 'E-COM-006'
      err.status = 409
      err.details = { latest: normalizePlanTaskDetail(taskId, src) }
      throw err
    }
    Object.assign(src, {
      title: body.title ?? src.title,
      estimatedMinutes: body.estimatedMinutes ?? src.estimatedMinutes,
      priority: body.priority ?? src.priority,
      dueDate: body.dueDate !== undefined ? body.dueDate : src.dueDate,
      // First save captures whatever status the form showed (itself the
      // DERIVED value, if never explicitly saved before) — see
      // normalizePlanTaskDetail's own `src.status || derivePlanTaskStatus`.
      // From then on this explicit value wins over the derived one, exactly
      // like every other persisted field here.
      status: body.status ?? src.status ?? derivePlanTaskStatus(taskId),
      // W3 fix (Thomas 리뷰 MAJOR): body.category → body.categoryId. 편집 폼은
      // categoryId만 보낸다(TaskEditModal) — 이 필드가 여전히 `category`를
      // 읽던 탓에 body.category가 항상 undefined였고, 그래서 사용자가 카테고리를
      // 골라 저장해도 조용히 src.category(옛 필드, 늘 null)로 되돌아갔다 —
      // 저장 성공 토스트는 뜨는데 값은 반영 안 되는 최악의 실패 방식이었다.
      // `undefined`-check(⁠`??`가 아님)는 projectFixtures의 동일 필드와 같은
      // 이유: "없음"으로 지우는 것도 정당한 값이라 falsy만으로 "안 보냄"을
      // 오판하면 안 된다.
      categoryId: body.categoryId !== undefined ? body.categoryId : src.categoryId,
      memo: body.memo ?? src.memo,
    })
    src.version = currentVersion + 1
    src.updatedAt = new Date().toISOString()

    // Reflect the new title onto every PLACED block for this task, so the
    // calendar grid shows the edit on refetch (mirrors updateSchedule's own
    // title-mirroring for SCHEDULE blocks below). Deliberately NOT resizing
    // a block's startAt/endAt to a new estimatedMinutes — that would
    // silently move/resize something the user never touched on the grid, a
    // bigger behavior change than "reflect the edit" calls for. Persisting
    // the task record itself (above) is the guaranteed part; this mirror is
    // best-effort and title-only.
    if (body.title !== undefined) {
      for (const week of weeks.values()) {
        for (const block of week.blocks) {
          if (block.taskId === taskId) block.title = src.title
        }
      }
    }

    return { message: 'UPDATED' }
  },

  // DELETE /plan-blocks/{planBlockId}. A SCHEDULE block is simply removed
  // (PLAN-18 삭제); a TASK block is removed AND its task returns to the unplaced
  // backlog (PLAN-16 배치 해제) — same endpoint, behavior keyed by block type.
  async deleteBlock(planBlockId) {
    await delay()
    for (const week of weeks.values()) {
      const block = week.blocks.find((b) => b.planBlockId === planBlockId)
      if (!block) continue
      week.blocks = week.blocks.filter((b) => b.planBlockId !== planBlockId)
      // TASK: the task stays in placedTaskData; removing its block(s) just raises
      // its unplaced remainder (full est when none remain) — PLAN-16 via A4 model.
      // SCHEDULE: gone for good.
      if (block.blockType === 'TASK' && block.taskId) {
        // Safety net: if it was never routed through placedTaskData, seed it now
        // so the freed time reappears in the backlog.
        if (!placedTaskData.has(block.taskId)) {
          placedTaskData.set(block.taskId, {
            taskId: block.taskId,
            title: block.title,
            estimatedMinutes: block.estimatedMinutes ??
              Math.round((new Date(block.endAt) - new Date(block.startAt)) / 60000),
            priority: block.priority ?? 2,
            projectId: block.projectId ?? null,
            projectName: block.projectName ?? null,
            dueDate: null,
            reason: null,
          })
        }
        return { message: 'UNASSIGNED' }
      }
      return { message: 'DELETED' }
    }
    // Idempotent: a block already gone (e.g. an optimistic temp-id that reconciled
    // to a real id before this landed) is treated as deleted, not an error.
    return { message: 'DELETED' }
  },

  // POST /weekly-plans/{id}/blocks (blockType=SCHEDULE) — PLAN-08 일정 배치. Creates
  // a schedule record and its mirroring SCHEDULE block.
  async createScheduleBlock(weeklyPlanId, body) {
    await delay()
    const week = findWeekByPlanId(weeklyPlanId)
    if (!week) throw new Error(`mock: plan ${weeklyPlanId} not found`)
    const scheduleId = nextId('sched')
    schedulesById.set(scheduleId, {
      scheduleId,
      title: body.title,
      estimatedMinutes: body.estimatedMinutes ?? null,
      priority: body.priority ?? 2,
      memo: body.memo ?? '',
      status: 'ACTIVE',
      // Every other create path in this codebase seeds a fresh row at
      // version 1 (project/task/fixedSchedule — see their own mocks); a
      // Schedule (openapi-live-76c7009.yaml:2498-2508) is no exception. Read
      // back by scheduleApi.js's own version tracker (see that file's header
      // for why the tracker exists at all).
      version: 1,
    })
    const block = {
      planBlockId: nextId('block'),
      blockType: 'SCHEDULE',
      title: body.title,
      tone: null,
      status: 'SCHEDULED',
      taskId: null,
      scheduleId,
      startAt: body.startAt,
      endAt: body.endAt,
    }
    week.blocks.push(block)
    return { planBlockId: block.planBlockId, scheduleId }
  },

  // PATCH /schedules/{scheduleId} — PLAN-17 일정 편집. Updates the schedule record
  // AND its block's mirrored title/time.
  //
  // BLOCKER FIX (W6 계약 감사): this used to apply `patch` unconditionally and
  // return `{message}` with no `version` at all — `version` is `required` in
  // the request per openapi-live-76c7009.yaml:1857 and MUST 409
  // (VersionConflict/E-COM-006) on a mismatch, same as every other
  // optimistic-lock endpoint's mock in this codebase. Without this, the
  // scheduleApi.js version tracker (see that file's header) would have
  // nothing real to key off, and a genuine edit conflict could never surface
  // even once scheduleApi.js started sending `version` at all.
  async updateSchedule(scheduleId, patch) {
    await delay()
    const current = schedulesById.get(scheduleId) ?? { scheduleId, version: 1 }
    const currentVersion = current.version ?? 1
    if (patch.version != null && patch.version !== currentVersion) {
      const err = new Error('mock: schedule version conflict')
      err.code = 'E-COM-006'
      err.status = 409
      err.details = { latest: { ...current, version: currentVersion } }
      throw err
    }
    const next = { ...current, ...patch, version: currentVersion + 1 }
    schedulesById.set(scheduleId, next)
    for (const week of weeks.values()) {
      for (const block of week.blocks) {
        if (block.scheduleId === scheduleId) {
          if (patch.title != null) block.title = patch.title
          if (patch.startAt != null) block.startAt = patch.startAt
          if (patch.endAt != null) block.endAt = patch.endAt
        }
      }
    }
    // Real PATCH returns `{data: Schedule}` (unwrapped to the bare Schedule by
    // the axios interceptor) — this mock bypasses that interceptor entirely
    // (withDevFallback calls it directly), so it has to hand back the SAME
    // bare shape itself, not `{message}`, or scheduleApi.js's own
    // `result?.version` read (the other half of the version round-trip) would
    // never see a real value against the mock.
    return next
  },

  // POST /weekly-plans/{id}/validations — the dry-run (ST-F1-05 AC-1, path
  // corrected W4 — see planApi.validatePlan's own header). Runs the rules
  // against the CLIENT's block set (the unsaved draft), never the stored
  // one, and writes nothing. Kept fast on purpose: the whole loop — local change →
  // 300ms debounce → this call → badge update — has a 1s budget (NFR-025).
  async validatePlan(weeklyPlanId, blocks) {
    await delay(50)
    const week = findWeekByPlanId(weeklyPlanId)
    if (!week) throw new Error(`mock: plan ${weeklyPlanId} not found`)
    // W3: pushIssue (computeValidationIssues) now stamps each issue's own
    // `severity` (server-shaped 'BLOCK'/'WARNING') at creation time — this used
    // to re-derive it here from the old bare `code`, which is no longer needed
    // (and would have silently stopped matching anything once the codes were
    // re-keyed to the real ruleId format, same trap the two consumers above
    // were just fixed for).
    const issues = computeValidationIssues(week.weekStartDate, blocks ?? [])
    // ADR-0013: savable = 차단(BLOCK) 0건. The mock computes this itself (no
    // controller exists yet to ask) so planApi.normalizeValidationPayload's own
    // `savable` field has a real value to carry even on the mock path — see
    // that function's own header for why the derived fallback and this value
    // are guaranteed to agree.
    const savable = !issues.some((i) => i.severity === 'BLOCK')
    return { issues, savable }
  },

  // POST /weekly-plans/{weeklyPlanId}/confirmation — PLAN-03 저장(확정), W4
  // (was PUT with a status body; the real endpoint takes NO body — see
  // planApi.saveWeek's own header — so this mock no longer reads one either).
  // Flips the week to CONFIRMED, stamps confirmedAt, bumps `version` (what a
  // real optimistic-lock 409/E-COM-006 would key off; the mock never rejects,
  // so that path is exercised against a real server rather than simulated
  // here). Response shape now matches `WeeklyPlan` (openapi.yaml) instead of
  // the old ad-hoc `{ weeklyPlanId }` — nothing in this app actually reads
  // the resolved value today (useSaveWeek's onSuccess ignores it and
  // refetches instead), but the mock still owes a shape a future consumer
  // could rely on without being surprised it's mock-only.
  async saveWeek(weeklyPlanId) {
    await delay()
    const week = findWeekByPlanId(weeklyPlanId)
    if (!week) throw new Error(`mock: plan ${weeklyPlanId} not found`)
    week.status = 'CONFIRMED'
    week.version += 1
    week.confirmedAt = new Date().toISOString()
    return {
      weeklyPlanId: week.weeklyPlanId,
      weekStartDate: week.weekStartDate,
      weekEndDate: week.weekEndDate,
      status: week.status,
      totalPlannedMinutes: computeDerived(week).totalPlannedMinutes,
      confirmedAt: week.confirmedAt,
      version: week.version,
    }
  },

  // POST /tasks/{taskId}/execution-logs — PLAN-15 실제 시간 기록 (write-only).
  // 계약대로 `body`에 `result`(COMPLETED/DELAYED/ABORTED)가 항상 실려 온다는
  // 전제 — taskApi.postExecutionRecord가 더 이상 기본값을 채워 넣지 않으므로
  // (통계 오염 방지), 이 목도 계약과 같은 모양을 유지하려면 값이 없을 때
  // 조용히 채워 넣지 않고 그대로 저장해야 한다(= real 서버가 422로 거부할
  // 상황을 목이 대신 감춰서는 안 된다).
  async logExecution(taskId, body) {
    await delay(150)
    const executionRecordId = nextId('exec')
    executionRecords.push({ executionRecordId, taskId, ...body })
    return { executionRecordId }
  },

  // POST /weekly-plans/{id}/replan-options — ST-F1-07 PLAN-29. Runs ONE strategy
  // against the CURRENT (unsaved) block set — a longer delay than most writes
  // here on purpose (220ms, matching autoPlace's own "visible beat" choice): the
  // modal's 5-second slow notice (NFR-029) needs something to eventually notice
  // in a slow/real environment, and disappearing instantly would never exercise it.
  async generateReplanOption(weeklyPlanId, strategyType) {
    await delay(220)
    const week = findWeekByPlanId(weeklyPlanId)
    if (!week) throw new Error(`mock: plan ${weeklyPlanId} not found`)
    const option = buildReplanOption(week, computeDerived(week).blocks, strategyType)
    if (!option) return { replanOptions: [] }
    const replanOptionId = nextId('replan')
    // Remembered so a later selectReplanOption(id) can find its proposedBlocks
    // (see replanOptionsById's header comment above).
    replanOptionsById.set(replanOptionId, { ...option, weeklyPlanId })
    return { replanOptions: [{ ...option, replanOptionId }] }
  },

  // POST /replan-options/{id}/application — ST-F1-07 AC-3 "초안 교체 반영", W4
  // (was PATCH .../selection; see replanApi.js's own header for the endpoint
  // correction). The real endpoint now returns a full WeeklyPlanView, but the
  // client still always REFETCHES after this resolves rather than consuming
  // it (replanApi.selectReplanOption's own header explains why) — so this
  // mock just needs that refetch to return the swapped blocks; the `{message}`
  // shape below is kept only because nothing reads it either way. FIXED
  // schedules are never plan_blocks, so nothing
  // about them needs preserving here — only week.blocks is replaced.
  async selectReplanOption(replanOptionId) {
    await delay()
    const option = replanOptionsById.get(replanOptionId)
    if (!option) throw new Error(`mock: replan option ${replanOptionId} not found`)
    const week = findWeekByPlanId(option.weeklyPlanId)
    if (!week) throw new Error(`mock: plan ${option.weeklyPlanId} not found`)
    week.blocks = option.proposedBlocks.map((b) => ({ ...b }))
    return { message: 'APPLIED' }
  },
}

export default mockBackend
