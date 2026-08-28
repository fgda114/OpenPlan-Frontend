/*
  §DASH.2 우선 행동 라벨 + 이동 경로 카탈로그.

  경위(중요 — 다시 지우지 말 것): 한 번은 이 파일이 "서버가 routePath를 직접
  주니 FE가 actionType→URL을 조립할 이유가 없다"는 전제로 이 `to()` 빌더를
  통째로 지운 적이 있다. 그 전제는 실서버 응답으로 반증됐다(리드 확인,
  2026-08-28) — 실제 `priorityAction.routePath`/`riskIssues[].routePath`
  값은 URL이 아니라 **화면 명세 식별자 문자열**이다. 예:
    "SCR-PLAN 미배치 패널"
  이걸 그대로 `navigate()`에 넘기면 `/SCR-PLAN 미배치 패널`로 이동해 404가
  난다(대시보드 "먼저 확인할 내용" 클릭 시 실제로 재현된 결함). 그래서
  **서버 routePath는 신뢰하지 않는다** — actionType/riskType → 실제 앱
  라우트로 가는 이 카탈로그가 유일한 정본이다. §DASH.2(ui-spec-dash.md)의
  "행동→화면 매핑 표는 유지" 지시와 일치한다.

  라우트 근거(ui-spec-dash.md §DASH.2 "키·라벨" 표, [미정→리드] 임시 계약):
    충돌 확인하기(RESOLVE_FIXED_CONFLICT)     → /weekly
    지금 배치하기(PLACE_UNASSIGNED)           → /weekly?openUnplaced=1
    다시 계획하기(REPLACE_TODAY_INCOMPLETE)   → /weekly?openReplan=1
    오늘 처리하기(HANDLE_DEADLINE)            → /weekly
  두 경로 다 WeeklyPage.jsx가 실제로 읽는 seam이다(각각 ST-F1-08/10,
  ST-F1-07의 `?openUnplaced=1`/`?openReplan=1` 처리 참고).

  ui-spec은 "범위 조정하기(FIX_OUT_OF_WBS) → /projects/{id}?tab=plan"도
  적지만, 실제 `DashboardView` 계약(openapi-live-76c7009.yaml)엔
  priorityAction·riskIssues 어느 쪽에도 projectId가 없다 — {id}를 채울 값이
  없어 그 라우트를 조립할 수 없다. 없는 데이터로 억지로 만든 링크는 또 다른
  404 위험이므로, 스펙과 다르더라도 **이동 자체를 막는다**(to: null, 아래
  참고).

  RESOLVE_OVERLAP·RESOLVE_CAPACITY는 애초에 ui-spec의 "해결 라벨 4종"에도
  없고 대응하는 riskType도 없다(계약에 riskType 4종만 존재) — 라우트를
  아는 값이 아니므로 역시 to: null.
*/

export const ACTION_ROUTES = {
  RESOLVE_FIXED_CONFLICT: { label: '고정 일정 충돌 확인하기', to: '/weekly' },
  // ui-spec §DASH.5 라벨 목록에도 없고 대응 riskType도 없다 — 아는 라우트가
  // 없으므로 링크를 만들지 않는다(버튼 없이 문제만 표시, §DASH.2 지시).
  RESOLVE_OVERLAP: { label: '겹치는 일정 확인하기', to: null },
  PLACE_UNASSIGNED: { label: '미배치 태스크 배치하기', to: '/weekly?openUnplaced=1' },
  REPLACE_TODAY_INCOMPLETE: { label: '오늘 미완료 다시 계획하기', to: '/weekly?openReplan=1' },
  // ui-spec은 /projects/{id}?tab=plan을 적지만 projectId를 줄 필드가 계약에
  // 없다(위 헤더 참고) — 만들 수 없는 라우트라 링크를 만들지 않는다.
  FIX_OUT_OF_WBS: { label: 'WBS 기간 밖 배치 조정하기', to: null },
  // RESOLVE_OVERLAP과 같은 이유(라벨 4종/riskType 매핑 밖) — 링크 없음.
  RESOLVE_CAPACITY: { label: '가용 시간 초과 확인하기', to: null },
  HANDLE_DEADLINE: { label: '마감 임박 태스크 처리하기', to: '/weekly' },
}

// riskIssues[] 행은 actionType이 아니라 riskType만 갖는다(계약에 없음) — 별도
// 축이 필요하다. priorityAction과 의미가 겹치는 3종은 위 ACTION_ROUTES와 같은
// 목적지를 그대로 재사용한다(계약상 같은 문제를 가리킨다는 보장은 없지만,
// RiskList.jsx의 ACTION_TYPE_TO_RISK_TYPE dedup 표와 같은 성격의 판단값).
// OUT_OF_WBS는 FIX_OUT_OF_WBS와 동일한 이유(projectId 없음)로 링크 없음.
const RISK_TYPE_ROUTES = {
  UNASSIGNED_TASKS: '/weekly?openUnplaced=1',
  OUT_OF_WBS: null,
  FIXED_CONFLICT: '/weekly',
  DEADLINE_SOON: '/weekly',
}

/**
 * 서버 `routePath`를 아주 방어적으로만 쓴다: 실제 URL처럼 보일 때
 * (`/`로 시작)만 최후 수단 폴백으로 인정하고, 그 외(현재 항상 그런 값 —
 * "SCR-PLAN 미배치 패널" 같은 명세 라벨)는 무조건 버린다. 카탈로그가 이미
 * 아는 라우트를 갖고 있으면 이 폴백은 아예 호출되지 않는다(카탈로그가
 * 항상 우선) — 서버 값이 우리 판단보다 더 정확하다고 믿을 근거가 없다.
 */
function safeServerRoutePath(routePath) {
  return typeof routePath === 'string' && routePath.startsWith('/') ? routePath : null
}

/**
 * `actionType`의 사람이 읽는 라벨, 또는 이 build가 모르는 값이면 `null`.
 */
export function resolveActionLabel(actionType) {
  return ACTION_ROUTES[actionType]?.label ?? null
}

/**
 * priorityAction 행의 이동 경로. 카탈로그에 없는 actionType은 서버
 * routePath가 진짜 URL 형태일 때만 최후 수단으로 쓴다 — 그것도 아니면 `null`
 * (비인터랙티브 행으로 렌더된다, RiskList.jsx 참고).
 */
export function resolveActionRoute(actionType, serverRoutePath) {
  const entry = ACTION_ROUTES[actionType]
  if (entry) return entry.to ?? safeServerRoutePath(serverRoutePath)
  return safeServerRoutePath(serverRoutePath)
}

/**
 * riskIssues[] 행의 이동 경로. actionType과 동일한 규칙(카탈로그 우선,
 * 그다음 방어적 서버 폴백)을 riskType 축으로 적용한다.
 */
export function resolveRiskRoute(riskType, serverRoutePath) {
  if (riskType && riskType in RISK_TYPE_ROUTES) {
    return RISK_TYPE_ROUTES[riskType] ?? safeServerRoutePath(serverRoutePath)
  }
  return safeServerRoutePath(serverRoutePath)
}

export default ACTION_ROUTES
