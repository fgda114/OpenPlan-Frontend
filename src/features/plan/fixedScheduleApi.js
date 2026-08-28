/*
  OP functions for fixed schedules (ST-F1-06 — PLAN-33/34 주차 예외). Each maps 1:1
  to an endpoint; the TanStack hooks (usePlanData.js) call ONLY these. Same DEV
  mock-fallback rule as planApi/scheduleApi/taskApi: real path in prod, mock only
  on a genuine network error.

  ASSUMPTION (unconfirmed with BE — flagged in the PR, not decided unilaterally):
  the 07번 API 명세서's `GET /fixed-schedules` takes only `status` and returns a
  flat list with no weekly concept, while `activeThisWeek` (api-contracts.md §5-J6)
  is inherently PER WEEK — a fixed schedule can be deactivated for one week and
  stay active every other week. Until BE confirms the real shape, this client
  asks for the CURRENTLY VIEWED week via an extra `weekStartDate` query param and
  expects the server to fold its week-exception state into an `activeThisWeek`
  field per schedule. This is the smallest, most reversible guess available (one
  extra param on an existing GET, not a second endpoint or a client-side merge of
  two separate lists) — if BE settles on something else (e.g. a dedicated
  GET .../week-exceptions), only `normalizeFixedSchedule` and `getFixedSchedules`
  below need to change; every consumer already just reads `activeThisWeek` off
  the normalized shape.
*/

import { apiClient } from '../../api/client'
import { withDevFallback, minutesFromTime, timeFromMinutes } from './planApi'
import { addDaysISO } from './planTime'
import { mockBackend } from './planFixtures'
import { unwrapList } from '../../api/unwrap'

/**
 * Normalize a fixed schedule to the camelCase shape the grid AND the ST-F1-12
 * settings screen both read. version/effectiveFrom/effectiveTo/source/status
 * (ST-B2-12's fixed_schedules columns) are additive — of these, only `version`
 * is actually consumed anywhere in this codebase today (the optimistic-lock
 * check on update). `effectiveFrom`/`effectiveTo`/`source`/`status` are kept
 * normalized here so the shape round-trips cleanly (the mock backend already
 * threads them through create/update), but NO current screen reads or writes
 * them — neither the ST-F1-06 grid nor FixedScheduleForm (ST-F1-12's own CRUD
 * form only edits title/weekday/start/end minutes). They're reserved fields,
 * unused/on hold until a future story actually surfaces them in the UI.
 */
function normalizeFixedSchedule(f) {
  return {
    fixedScheduleId: f.fixedScheduleId ?? f.fixed_schedule_id,
    title: f.title,
    weekday: f.weekday,
    // 🔴 서버는 `startTime`/`endTime`을 시각 문자열("09:00:00")로 보낸다 —
    //    `startMinutes`라는 이름은 계약에 없다(openapi FixedScheduleInput). 이걸
    //    변환하지 않아 화면 전체가 undefined를 받았고, 시:분 계산이 `NaN:NaN`으로
    //    렌더됐다. 가용 시간(normalizeAvailability)이 이미 쓰는 것과 같은 폴백
    //    사슬을 그대로 따른다 — 목(분 단위)과 실서버(시각 문자열)를 둘 다 받는다.
    startMinutes: f.startMinutes ?? f.start_minutes ?? minutesFromTime(f.startTime ?? f.start_time),
    endMinutes: f.endMinutes ?? f.end_minutes ?? minutesFromTime(f.endTime ?? f.end_time),
    // Defaults to true: a server that doesn't yet understand week exceptions
    // (or omits the field) should render every fixed schedule as ACTIVE, not
    // silently ghost all of them — an unrecognized false would be the wrong
    // failure direction (hiding a real conflict), so only an explicit false wins.
    activeThisWeek: (f.activeThisWeek ?? f.active_this_week) !== false,
    // 🔴 서버가 보내는 이름은 `startDate`/`endDate`다. 이름이 어긋나 항상 null이
    //    됐고, 그래서 **하루짜리 일정이 매주 반복으로 보였다** — 외부 캘린더에서
    //    반영한 일정(ExternalEventToFixedSchedule이 startDate=endDate=그 날짜로
    //    하루에 가둔다)이 모든 같은 요일에 뜨던 원인이다.
    effectiveFrom: f.effectiveFrom ?? f.effective_from ?? f.startDate ?? f.start_date ?? null,
    effectiveTo: f.effectiveTo ?? f.effective_to ?? f.endDate ?? f.end_date ?? null,
    source: f.source ?? 'MANUAL',
    status: f.status ?? 'ACTIVE',
    version: f.version ?? 1,
    // Settings-list-only convenience (see planFixtures.getFixedSchedulesAll's
    // own comment) — undefined on the week-scoped grid read, never a false
    // "no conflict" claim it can't back up.
    hasConflict: f.hasConflict ?? undefined,
  }
}

/**
 * 화면이 쓰는 분 단위를 계약이 요구하는 시각 문자열로 되돌린다.
 *
 * 🔴 계약(openapi `FixedScheduleInput`)은 `startTime`·`endTime`을 **required**로
 * 요구하는데, 폼은 `{startMinutes, endMinutes}`를 그대로 실어 보내고 있었다 —
 * 읽기 쪽 이름 불일치(normalizeFixedSchedule 참조)의 거울상이라, 손으로 만드는
 * 고정 일정도 같은 이유로 서버에 닿지 못했다.
 *
 * 화면(폼·그리드·설정 목록)은 분 단위 그대로 두고 **이 경계에서만** 바꾼다.
 * 화면 전체를 시각 문자열로 옮기는 것은 훨씬 큰 변경이고, 계약과 UI 모델이
 * 다른 것 자체는 정상이다 — 어긋나 있던 것은 그 사이를 잇는 어댑터뿐이었다.
 *
 * 이미 시각 문자열이면 건드리지 않는다(목 경로·미래의 호출부 대비).
 */
function toServerFixedSchedule(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const body = { ...payload }
  if (body.startTime == null && Number.isFinite(body.startMinutes)) {
    body.startTime = timeFromMinutes(body.startMinutes)
  }
  if (body.endTime == null && Number.isFinite(body.endMinutes)) {
    body.endTime = timeFromMinutes(body.endMinutes)
  }
  delete body.startMinutes
  delete body.endMinutes
  return body
}

/**
 * 이 주에 실제로 나타나야 하는 고정 일정인가.
 *
 * 🔴 고정 일정은 기본적으로 **요일 반복**이지만, 외부 캘린더에서 반영한 일정은
 * `startDate=endDate=그 날짜`로 하루에 갇혀 있다(백엔드 ExternalEventToFixedSchedule).
 * 그 경계를 보지 않으면 하루짜리 약속이 **모든 같은 요일**에 나타난다 — 그 위에
 * 계획을 얹지 못하게 막으므로 조용한 오표시가 아니라 실제 배치 제약이 된다.
 *
 * 경계가 둘 다 없으면 무기한 반복(손으로 만든 고정 일정)이라 항상 보인다.
 * ISO 날짜 문자열(YYYY-MM-DD)은 사전순 비교가 곧 시간순이라 그대로 비교한다.
 */
function activeInWeek(schedule, weekStartISO) {
  if (!weekStartISO) return true
  const { effectiveFrom, effectiveTo } = schedule
  if (!effectiveFrom && !effectiveTo) return true
  const weekEndISO = addDaysISO(weekStartISO, 6)
  if (effectiveFrom && effectiveFrom > weekEndISO) return false
  if (effectiveTo && effectiveTo < weekStartISO) return false
  return true
}

/**
 * OP-FIXED-LIST → GET /fixed-schedules?status=ACTIVE&weekStartDate= (ASSUMPTION
 * above). Returns the week's recurring fixed schedules with `activeThisWeek`.
 */
export function getFixedSchedules(weekStartISO) {
  return withDevFallback(
    () =>
      apiClient.get('/fixed-schedules', {
        params: { status: 'ACTIVE', weekStartDate: weekStartISO },
      }),
    () => mockBackend.getFixedSchedules(weekStartISO),
    // Real: `data:[FixedSchedule]` (array). Mock: `{ fixedSchedules: [...] }`.
  ).then((r) =>
    unwrapList(r, 'fixedSchedules')
      .map(normalizeFixedSchedule)
      // 서버가 weekStartDate 를 받고도 날짜 경계로 걸러 주지 않으므로 여기서 건다.
      // 서버가 나중에 걸러 주게 되면 이 필터는 그냥 통과라 이중으로 걸려도 무해하다.
      .filter((f) => activeInWeek(f, weekStartISO)),
  )
}

/**
 * OP-FIXED-EXCEPT-ADD → POST /fixed-schedules/{id}/week-exceptions (PLAN-33 이번
 * 주만 비활성화). Body carries the week the exception applies to — the endpoint
 * itself has no other way to know which week the current screen is showing.
 */
export function addFixedException(fixedScheduleId, weekStartISO) {
  return withDevFallback(
    () =>
      apiClient.post(`/fixed-schedules/${fixedScheduleId}/week-exceptions`, {
        weekStartDate: weekStartISO,
      }),
    () => mockBackend.addFixedWeekException(fixedScheduleId, weekStartISO),
  )
}

/**
 * OP-FIXED-EXCEPT-DEL → DELETE /fixed-schedules/{id}/week-exceptions/{weekStart}
 * (PLAN-34 다시 활성화). Server-idempotent (api-contracts.md §2.2), but still only
 * ever consumed via `useMutation` (retry:0) — DELETE gets no automatic retry
 * either, per the retry-policy note above OP-FIXED-EXCEPT-ADD/DEL: automatic
 * retry is a GET-only privilege, writes retry solely on the user's own click.
 */
export function removeFixedException(fixedScheduleId, weekStartISO) {
  return withDevFallback(
    () => apiClient.delete(`/fixed-schedules/${fixedScheduleId}/week-exceptions/${weekStartISO}`),
    () => mockBackend.removeFixedWeekException(fixedScheduleId, weekStartISO),
  )
}

// --- ST-F1-12: 고정 일정 관리 (설정) — CRUD + 충돌 미리보기 --------------------

/**
 * OP-FIXED-LIST-ALL → GET /fixed-schedules (no weekStartDate — the settings
 * list is week-agnostic, unlike getFixedSchedules above which the PLAN GRID
 * scopes to the currently viewed week).
 */
export function getAllFixedSchedules() {
  return withDevFallback(
    () => apiClient.get('/fixed-schedules'),
    () => mockBackend.getFixedSchedulesAll(),
    // Real: `data:[FixedSchedule]` (array). Mock: `{ fixedSchedules: [...] }`.
  ).then((r) => unwrapList(r, 'fixedSchedules').map(normalizeFixedSchedule))
}

/** OP-FIXED-CREATE → POST /fixed-schedules (FIX-06 고정일정 직접 추가). */
export function createFixedSchedule(payload) {
  return withDevFallback(
    () => apiClient.post('/fixed-schedules', toServerFixedSchedule(payload)),
    () => mockBackend.createFixedSchedule(payload),
  ).then(normalizeFixedSchedule)
}

/**
 * OP-FIXED-UPDATE → PATCH /fixed-schedules/{id} (FIX-07 편집). `patch` must
 * carry `version` for the optimistic-lock check (E-COM-006, common invariant).
 */
export function updateFixedSchedule(fixedScheduleId, patch) {
  return withDevFallback(
    () => apiClient.patch(`/fixed-schedules/${fixedScheduleId}`, toServerFixedSchedule(patch)),
    () => mockBackend.updateFixedSchedule(fixedScheduleId, patch),
  ).then(normalizeFixedSchedule)
}

/** OP-FIXED-DELETE → DELETE /fixed-schedules/{id} (FIX-09 삭제). */
export function deleteFixedSchedule(fixedScheduleId) {
  return withDevFallback(
    () => apiClient.delete(`/fixed-schedules/${fixedScheduleId}`),
    () => mockBackend.deleteFixedSchedule(fixedScheduleId),
  )
}

/**
 * OP-FIXED-CONFLICT-PREVIEW → POST /fixed-schedules/conflict-previews
 * (FIX-08 저장 전 충돌 미리보기, dry-run — no persistence either side, ST-B2-12
 * AC-1). Called BEFORE create/update commits so the form can show "저장해도
 * 되지만 이 주들에 차단이 생깁니다" without writing anything yet — saving despite
 * a conflict is allowed (owner decision, ST-F1-12 AC-2); this call only informs
 * that choice.
 */
export function previewFixedScheduleConflicts(candidate) {
  return withDevFallback(
    // 🔴 계약은 `{candidate: FixedScheduleInput}` 봉투를 요구하고, 그 안의 시각은
    //    `startTime`/`endTime`이다(ConflictPreviewRequest.Candidate). 폼은 봉투 없이
    //    `{weekday, startMinutes, endMinutes}`를 그대로 보내고 있었다 — 위
    //    normalizeFixedSchedule·toServerFixedSchedule과 같은 계열의 불일치다.
    //    이 호출은 디바운스된 배경 요청이라 실패해도 화면에 오류가 안 뜬다.
    //    그래서 "충돌 경고가 한 번도 안 뜬 것"이 결함으로 보이지 않았다.
    () => apiClient.post('/fixed-schedules/conflict-previews', {
      candidate: toServerFixedSchedule(candidate),
    }),
    () => mockBackend.previewFixedScheduleConflicts(candidate),
  )
}
