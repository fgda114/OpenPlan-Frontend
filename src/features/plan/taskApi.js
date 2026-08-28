/*
  OP functions for the unplaced panel & task placement (ST-F1-03 — ux-flow-map §2,
  api-contracts §2.7). Each maps 1:1 to an endpoint; the TanStack hooks call ONLY
  these, never apiClient directly, so the OP↔endpoint mapping stays in one place.

  Placement is a two-phase auto flow per the story AC (RB-PLAN-01):
    POST .../auto-placements  → a DRAFT set of proposed placements (no write)
    POST .../block-batches    → commit the applied draft
  keeping "적용 = 초안 확정, 저장(확정)은 별개" (C-2 double protection). The DEV
  mock fallback mirrors planApi's: real path in prod, mock only on a network error.
*/

import { apiClient } from '../../api/client'
import { withDevFallback } from './planApi'
import { mockBackend } from './planFixtures'
import { unwrapList } from '../../api/unwrap'
import { fetchAllPages } from '../../api/paging'
import { clampPriority } from './planPlacement'
import { snapDuration } from './planTime'

/** Normalize a task to the camelCase shape the panel reads (tolerates snake_case). */
function normalizeTask(t) {
  return {
    taskId: t.taskId ?? t.task_id,
    projectId: t.projectId ?? t.project_id ?? null,
    projectName: t.projectName ?? t.project_name ?? null,
    title: t.title,
    // Snapped to the 5-minute grid the weekly-plan endpoint enforces
    // (E-COM-009) right here at the read boundary — this is the ONE place
    // every consumer of this list (quick-place, drag preview, auto-place)
    // reads a task's duration from, so a server value that isn't already a
    // multiple of 5 gets caught before it can ever reach a block's start/end
    // math (see planTime.js's clampBlockSpan for the other half of this,
    // where it's re-checked at assembly time as a backstop).
    estimatedMinutes: snapDuration(t.estimatedMinutes ?? t.estimated_minutes ?? 60),
    // null stays null here (this panel sorts unknown priorities LAST — see
    // byPriorityThenDue's own 99 default — rather than treating them as 보통).
    priority: clampPriority(t.priority, null),
    dueDate: t.dueDate ?? t.due_date ?? null,
    // The optimistic-lock counter, carried so a completion toggle driven from
    // THIS list can send it without re-reading the task (see patchTaskStatus).
    version: t.version ?? t.task_version ?? null,
    // Present only on auto-place leftovers (AC-3): why a task stayed unplaced.
    reason: t.reason ?? null,
  }
}

// tasks.status values (ERD) that mean the task is NOT in the unplaced backlog.
const PLACED_OR_DONE = new Set(['IN_PROGRESS', 'COMPLETED'])

/**
 * OP-TASK-UNPLACED → GET /tasks?status=UNASSIGNED.
 *
 * PARAM CORRECTION (BE 확인, 2026-07-29): the real endpoint takes NO
 * `projectId` query param — it was being sent as a filter the server simply
 * has no binding for. A project-scoped call therefore filters client-side on
 * the normalized `projectId` instead of asking the server to.
 *
 * `status` is likewise re-checked here rather than trusted: if the server
 * ignores that param too (unconfirmed — BE only ruled on `projectId`), an
 * unfiltered list would otherwise render every task in the account as
 * "미배치". Deliberately a DENY list of the two ERD values that mean "not in
 * the backlog" (IN_PROGRESS = 배치됨, COMPLETED = 완료), not an allow-list of
 * 'UNASSIGNED': an enum value this FE doesn't recognize — or a payload with no
 * status at all, which is what the DEV mock returns — then still shows up.
 * Showing one task too many is recoverable; silently emptying the panel
 * because the server spells a status differently is not.
 *
 * `size`/paging (실서버 확인, 2026-07-29 → resolved W2+): this endpoint is
 * PAGED — `size` defaults to 20 and caps at 100 — so sending nothing silently
 * truncated the backlog at 20 with no indication, which the client-side
 * project filter above would then narrow further (a project's tasks could
 * vanish entirely just for sitting past the first page). This used to send
 * `size:100` (the server's own max) as a deliberate CEILING, not a fix,
 * because `meta.page` was dropped by client.js's interceptor and nothing here
 * could even SEE that a 101st task existed. Now that client.js exposes `meta`
 * behind an opt-in flag (see its own header comment), `fetchAllPages` (api/
 * paging.js) walks every page and this reads the true full backlog regardless
 * of size.
 */
export function getUnplacedTasks(projectId) {
  // One page = one `size:100` request with `withMeta: true` so the response
  // interceptor hands back `{data, meta}` instead of the bare payload.
  const realCall = (page, size) =>
    apiClient.get('/tasks', { params: { status: 'UNASSIGNED', page, size }, withMeta: true })
  // Mock fallback is wired ONLY into page 1 — see fetchAllPages's own header
  // comment on the mock/real mixing bug this split closes. Page 2+ (below,
  // passed as fetchNextPage) reuses the SAME `realCall`, unwrapped, so a later
  // page can never fall back to the mock's whole-list answer.
  const fetchFirstPage = (page, size) =>
    withDevFallback(
      () => realCall(page, size),
      () => mockBackend.getUnplacedTasks(projectId).then((data) => ({ data, meta: null })),
    )
  return fetchAllPages(fetchFirstPage, realCall, (data) => unwrapList(data, 'tasks')).then((items) =>
    items
      .filter((t) => !PLACED_OR_DONE.has(t.status ?? t.task_status ?? null))
      .map(normalizeTask)
      .filter((t) => !projectId || t.projectId === projectId),
  )
}

/**
 * OP-PLAN-PLACE → POST /weekly-plans/{id}/blocks (blockType=TASK). Places one
 * task at a target span. Returns { planBlockId }.
 */
export function postBlock(weeklyPlanId, body) {
  return withDevFallback(
    () => apiClient.post(`/weekly-plans/${weeklyPlanId}/blocks`, body),
    () => mockBackend.createBlock(weeklyPlanId, body),
  )
}

/**
 * OP-PLAN-AUTOPLACE → POST /weekly-plans/{id}/auto-placements. Returns a DRAFT
 * { placements, unplaced } — no server-side write happens here (the draft is
 * applied later via postBlockBatch).
 *
 * `priorityType` (owner/lead review, W2 API alignment): left WITHOUT a
 * default here — the button's only current call site (WeeklyPage's
 * handleAutoPlace) never passes one, which is what "우선순위·마감일 순으로
 * 배치 중입니다" (its own toast) has always meant. The previous default,
 * `'DEADLINE_FIRST'`, was never actually observable: the mock backend used to
 * accept-but-ignore this whole parameter, so every call silently behaved as
 * priority-first regardless of what was sent. Now that the mock branches on
 * it for real (see planFixtures.autoPlace's own header), keeping that stale
 * default here would have flipped the ONLY caller's real behavior to
 * due-date-first the moment the mock started honoring it — contradicting its
 * own toast text. `'DEADLINE_FIRST'` is still a real, meaningful value for a
 * FUTURE caller that explicitly wants that ordering (see planFixtures.js).
 */
export function postAutoPlacements(weeklyPlanId, priorityType) {
  return withDevFallback(
    () => apiClient.post(`/weekly-plans/${weeklyPlanId}/auto-placements`, { priorityType }),
    () => mockBackend.autoPlace(weeklyPlanId, priorityType),
  ).then((r) => ({
    // 🔴 CONTRACT (openapi PlacementProposal): `proposedBlocks` · `unplacedTaskIds`.
    // 이 어댑터는 오래도록 `placements` · `unplaced` 라는, 계약에 없는 이름을 읽고
    // 있었다. 목이 그 이름을 그대로 돌려줬기 때문에 DEV 에서는 완벽히 동작했고,
    // 실서버에서만 두 배열이 **언제나 비었다** — 서버가 5건을 배치해 보내도 화면은
    // "배치 0건" 이 되고, `적용` 은 placedCount === 0 이라 영구 비활성이었다
    // (2026-08-28 실서버 응답으로 확인). 목도 함께 계약 이름으로 고쳤다.
    placements: r?.proposedBlocks ?? [],
    // 🔴 계약은 태스크 **객체가 아니라 UUID 배열**이다. 그래서 normalizeTask 를
    //    씌우지 않는다(씌우면 id 문자열을 태스크로 오해해 빈 객체가 된다).
    //    현재 소비자는 개수뿐이다(WeeklyPage → AutoPlaceBar unplacedCount).
    unplaced: r?.unplacedTaskIds ?? [],
    // 배치 근거(규칙 경로면 정렬 규칙, AI 경로면 모델이 쓴 문구). 아직 화면에
    // 쓰지 않지만 계약 필드라 버리지 않고 그대로 싣는다.
    reason: r?.reason ?? null,
  }))
}

/**
 * OP-PLAN-BLOCKBATCH → POST /weekly-plans/{id}/block-batches. Commits an applied
 * auto-place draft as a batch of blocks. Returns { placedCount }.
 */
export function postBlockBatch(weeklyPlanId, placements) {
  // 🔴 CONTRACT (openapi applyBlockBatch): body 는 `{ operations: [...] }` 이고
  //    operations 는 @NotEmpty 다. 여기서 보내던 `{ placements }` 는 계약에 없는
  //    모양이라 실서버에서 400 이었다 — 초안을 적용할 방법이 아예 없었다.
  //    단위 연산은 op(CREATE/MOVE/DELETE) + block(PlanBlockInput) 조합이고,
  //    자동 배치 초안의 적용은 전부 CREATE 다(전부 새 TASK 블록).
  const operations = (placements ?? []).map((p) => ({
    op: 'CREATE',
    block: {
      blockType: 'TASK',
      taskId: p.taskId,
      startAt: p.startAt,
      endAt: p.endAt,
    },
  }))
  return withDevFallback(
    () => apiClient.post(`/weekly-plans/${weeklyPlanId}/block-batches`, { operations }),
    () => mockBackend.commitBatch(weeklyPlanId, placements),
  )
}

/**
 * The task's current optimistic-lock version, read straight off GET /tasks/{id}
 * — "태스크 불러올 때 응답에 같이 오는 숫자". Resolves to null instead of
 * throwing when the read fails, so a DEV run against no backend still reaches
 * patchTaskStatus's own mock fallback rather than dying on the lookup; against
 * a real server the PATCH that follows is what surfaces the failure.
 */
function readTaskVersion(taskId) {
  return apiClient
    .get(`/tasks/${taskId}`)
    .then((t) => t?.version ?? t?.task_version ?? null)
    .catch(() => null)
}

/**
 * OP-TASK-STATUS → PATCH /tasks/{taskId}/status (PLAN-13/14 완료/미완료).
 * Task-block completion mirrors onto its blocks.
 *
 * BODY CORRECTION (BE 확인, 2026-07-29): the real endpoint reads
 * `{ completed: boolean, version: number }` — NOT the `{ status: 'COMPLETED' }`
 * enum this used to send, which 400s. `version` is the task's optimistic-lock
 * counter, the same number every task read hands back.
 *
 * The weekly grid's toggle doesn't have that number: it acts on a plan BLOCK,
 * and a block payload carries no task version (planApi.normalizeBlock). So when
 * the caller can't supply one, the task is read first and the version THAT read
 * returned is what gets sent — the "받은 뒤에 그대로 같이 보내라" contract, just
 * resolved here instead of at every call site. Callers already holding a fresh
 * task (the unplaced list, which now carries `version`) pass it and skip the GET.
 */
export async function patchTaskStatus(taskId, completed, version) {
  const lockVersion = version ?? (await readTaskVersion(taskId))
  return withDevFallback(
    () => apiClient.patch(`/tasks/${taskId}/status`, { completed, version: lockVersion }),
    // The mock store still models completion as the task/block STATUS enum
    // (it mirrors the flag onto every block of the task, which is what the
    // grid re-reads) — the boolean is translated back for it here.
    () => mockBackend.setTaskStatus(taskId, completed ? 'COMPLETED' : 'IN_PROGRESS'),
  )
}

/**
 * OP-TASK-EXEC → POST /tasks/{taskId}/execution-logs (PLAN-15 실제 시간 기록).
 *
 * W6 PATH CORRECTION (팀장 지시, 2026-08-23): 주소가 `execution-records` →
 * `execution-logs`로 바뀌었다.
 *
 * CONTRACT GAP 해소 (2026-08-24): 계약의 요청 바디는
 * `{ startedAt, endedAt, actualMinutes, result, memo? }`로 `result`(enum
 * COMPLETED/DELAYED/ABORTED)가 **필수**다. 이 값이 수행 통계
 * (`GET /stats/summaries`의 completionRate·`GET /stats/deviations`)의
 * 원천이라 잘못 쌓이면 되돌릴 방법이 없다 — 그래서 예전에 여기서 잠정
 * 기본값 `'COMPLETED'`를 채워 보내던 걸(모든 기록이 "완료"로 영구 저장되는
 * 오염) **의도적으로 제거했다**. 이제 호출부(WeeklyPage.jsx·HomePage.jsx의
 * "실제 시간 기록" 모달 → ExecutionLogForm의 결과 선택 라디오)가 항상 실제
 * 값을 `body.result`로 채워 보낸다. 여기서 다시 기본값을 채우면 이 함정이
 * 조용히 되살아나므로, `result`가 없는 요청은 여기서 막지 않고 그대로
 * 보내 서버가 422로 거부하게 둔다 — "일단 성공하되 값이 틀린 것"보다
 * "바로 실패하는 것"이 통계 오염을 막는 데 낫다.
 *
 * Returns the created ExecutionLog.
 *
 * Guards `taskId` explicitly rather than letting a missing one silently
 * become the literal string "undefined" in the URL (`POST
 * /tasks/undefined/execution-logs`) — the mock backend below never
 * validates its `taskId` argument at all, so this call used to succeed
 * against the mock while a real server would 404/400 it. The caller (dashboard
 * TodayBoard's [기록] button) is now gated on `item.taskId` existing before
 * this ever fires, but this stays a hard guard rather than trusting every
 * future caller to remember that.
 */
export function postExecutionRecord(taskId, body) {
  if (taskId == null) {
    return Promise.reject(new Error('postExecutionRecord: taskId is required'))
  }
  return withDevFallback(
    () => apiClient.post(`/tasks/${taskId}/execution-logs`, body),
    () => mockBackend.logExecution(taskId, body),
  )
}
