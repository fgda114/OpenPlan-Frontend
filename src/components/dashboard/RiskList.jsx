import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge } from '../common/Badge'
import { ErrorState } from '../common/ErrorState'
import { CheckCircleIcon } from '../common/statusIcons'
import { severityLabels } from '../../features/plan/violationMessages'
import { resolveIssueCopy } from '../../features/dashboard/dashboardIssueCopy'
import { resolveActionLabel, resolveActionRoute, resolveRiskRoute } from '../../features/dashboard/actionRouting'

/*
  S5 · 먼저 확인할 내용 — DASH-03·04에 더해 S2 우선 행동(DASH-02·RB-DASH-01)까지
  흡수한다 (product-owner 지시, ui-spec-dash.md §DASH.2/§DASH.5 대비 델타 — 사양
  갱신 필요, 리드에게 보고됨). RB-DASH-01 원문이 "미배치 태스크·마감 임박 태스크
  ·고정 일정 충돌·가용 시간 초과 중 둘 이상 동시 존재 시 최고 우선순위 규칙으로
  선정된 행동"이라고 정의하는 이상, `priorityAction`은 이 목록과 같은 문제
  집합에서 뽑힌 한 항목이다 — 별도 카드로 다시 보여주면 같은 정보가 두 번
  노출되므로, 목록 맨 위에서 강조만 한다.

  강조는 색만으로 하지 않는다(NFR-017) — severity 배지 옆에 "우선 행동" 배지를
  병기하고, isPriority 행은 테두리로도 구분한다.

  dashboard-redesign delta (오너 목업, round 2 — 컴팩트화): 각 행을 여러 줄
  (배지+source 줄, 본문 줄, 별도 액션 버튼)에서 한 줄 [severity 배지] [내용
  텍스트(truncate)] [우선 행동 배지]로 압축했다. 행 전체가 버튼이 되어 클릭하면
  서버가 준 경로로 이동한다.

  계약 정합 delta (W6, 2026-08-23 — DashboardView): 예전엔 `priorityAction`과
  `risks[]` 행이 같은 `id`를 공유한다는 mock의 가정으로 dedup했다. 실제 계약엔
  둘 다 `id`가 없다 — `priorityAction`은 `{actionType, reason, routePath}`,
  `riskIssues[]` 행은 `{riskType, count, description, routePath}`뿐이라 공유
  식별자로 매칭할 방법이 없어졌다. 대신 `actionType`↔`riskType`의 의미적 대응
  (아래 ACTION_TYPE_TO_RISK_TYPE)으로 dedup한다 — 이것도 결정문에 없는 판단값
  (같은 문제를 가리킨다는 계약상 보장은 없음, 예전 dedup과 동일하게 "방어적
  조치"일 뿐) — 매칭되지 않는 actionType(RESOLVE_OVERLAP 등, riskType 4종에
  대응이 없음)은 그냥 최상단 별도 행으로 추가한다.

  routePath 정정(W6, 2026-08-28 — 리드 실서버 확인): 서버 `routePath`는 URL이
  아니라 화면 명세 식별자 문자열이다(예: "SCR-PLAN 미배치 패널") — 그대로
  이동하면 404가 난다. `actionRouting.js`의 `to()` 빌더(actionType/riskType →
  실제 앱 라우트)를 되살렸다 — 클릭 시 그 카탈로그가 준 경로로 이동하고,
  서버 routePath는 카탈로그가 모르는 값일 때 `/`로 시작하는 경우에만 최후
  수단 폴백으로 쓴다(자세한 근거는 actionRouting.js 헤더). 라우트가 없는
  행은 여전히 비인터랙티브 <div>.
*/

// priorityAction.actionType → 대응하는 riskIssues[].riskType. 매칭되는 게
// 없는 actionType(RESOLVE_OVERLAP · REPLACE_TODAY_INCOMPLETE · RESOLVE_CAPACITY)
// 은 이 표에 없다 — dedup 시도 없이 별도 행으로 취급된다.
const ACTION_TYPE_TO_RISK_TYPE = {
  RESOLVE_FIXED_CONFLICT: 'FIXED_CONFLICT',
  PLACE_UNASSIGNED: 'UNASSIGNED_TASKS',
  FIX_OUT_OF_WBS: 'OUT_OF_WBS',
  HANDLE_DEADLINE: 'DEADLINE_SOON',
}

// severity 랭크만 필요한 로컬 비교자 — violationMessages.compareBySeverity는
// PLAN-24~27의 `code` 기반이라(위 헤더 참고, 이 화면 데이터엔 code가 없다)
// 여기선 이미 resolveIssueCopy가 유도해 둔 severity 문자열로 직접 정렬한다.
const severityRank = (severity) => (severity === 'blocking' ? 0 : 1)

export function RiskList({ error = false, onRetry, priorityAction = null, risks = [] }) {
  const navigate = useNavigate()

  const sorted = useMemo(() => {
    const base = Array.isArray(risks) ? risks : []
    const withKey = base.map((r) => ({ ...r, _key: r.riskType }))

    let merged
    if (!priorityAction) {
      merged = withKey.map((r) => ({ ...r, isPriority: false }))
    } else {
      const matchType = ACTION_TYPE_TO_RISK_TYPE[priorityAction.actionType]
      const matchIndex = matchType ? withKey.findIndex((r) => r.riskType === matchType) : -1
      merged =
        matchIndex >= 0
          ? // 매칭된 행엔 priorityAction의 actionType도 얹어 둔다 — 렌더
            // 단계의 actionLabel(sr-only 보조 텍스트)이 이 필드로 라벨을
            // 찾으므로, 매칭 여부와 무관하게 항상 같은 정보를 준다.
            withKey.map((r, i) => ({
              ...r,
              isPriority: i === matchIndex,
              ...(i === matchIndex ? { actionType: priorityAction.actionType } : {}),
            }))
          : [
              { ...priorityAction, _key: 'priority-action', isPriority: true },
              ...withKey.map((r) => ({ ...r, isPriority: false })),
            ]
    }

    // 우선 행동은 severity와 무관하게 항상 맨 위 — RB-DASH-01이 이미 "최고
    // 우선순위 규칙"으로 골라준 결과이므로, 나머지는 차단>경고 정렬 그대로.
    return [...merged].sort((a, b) => {
      if (a.isPriority && !b.isPriority) return -1
      if (!a.isPriority && b.isPriority) return 1
      return severityRank(resolveIssueCopy(a).severity) - severityRank(resolveIssueCopy(b).severity)
    })
  }, [risks, priorityAction])

  if (error) {
    return (
      <section>
        <h2 className="mb-2 text-title font-semibold text-text">먼저 확인할 내용</h2>
        <ErrorState variant="section" onAction={onRetry} />
      </section>
    )
  }

  // 통합된 긍정 카드 자리(구 AC-3): 우선 행동도 없고 나열할 위험도 없을 때만 —
  // 즉 정말로 "아무 문제 없음"일 때만 보여준다(priorityAction: null은 오류가
  // 아니라 이 긍정 상태 자체를 뜻한다 — dashboardApi.js가 undefined와 구분해서
  // 그대로 통과시킨다). 위험은 있는데 우선 행동만 없는 경우는 목록이 비어
  // 있지 않으므로 그대로 나열한다.
  if (!priorityAction && sorted.length === 0) {
    return (
      <div className="rounded-card border border-border bg-surface p-4">
        <h2 className="text-title font-semibold text-text">먼저 확인할 내용</h2>
        <div className="mt-2 flex items-start gap-2">
          <CheckCircleIcon className="mt-0.5 shrink-0 text-success-600" size={20} />
          <div>
            <p className="text-body font-medium text-text">지금 처리할 문제가 없습니다</p>
            <p className="mt-0.5 text-label text-text-muted">계획대로 진행하면 됩니다</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <h2 className="text-title font-semibold text-text">먼저 확인할 내용</h2>
      <ul className="mt-2 divide-y divide-border">
        {sorted.map((risk) => {
          const copy = resolveIssueCopy(risk)
          // §DASH.2/actionRouting.js가 유일 정본 — 서버 routePath는 URL이
          // 아니라 화면 명세 라벨(예: "SCR-PLAN 미배치 패널")이라 그대로 쓰면
          // 404가 난다(actionRouting.js 헤더 참고, 실서버로 반증된 결함).
          // priorityAction 파생 행(actionType 있음)은 actionType 축으로,
          // 일반 riskIssues 행은 riskType 축으로 각각 카탈로그를 거친다.
          const to = risk.actionType
            ? resolveActionRoute(risk.actionType, risk.routePath)
            : resolveRiskRoute(risk.riskType, risk.routePath)
          // priorityAction 파생 행에만 actionType이 있다 — 그 라벨을 sr-only로
          // 앞세워 스크린 리더 사용자가 "무엇을 하는 이동인지" 시각 사용자보다
          // 덜 알게 되지 않도록 한다(일반 riskIssues 행은 actionType이 계약에
          // 없어 라벨을 못 붙인다 — badge + description 텍스트만으로도 이미
          // 충분히 설명적이라 생략).
          const actionLabel = risk.isPriority ? resolveActionLabel(risk.actionType) : null
          // 행 전체 클릭 타깃의 공통 클래스 — route가 있을 때만 hover/focus
          // 상태를 얹는다(정말로 클릭 가능한 행만 그렇게 보이도록).
          const rowClass = [
            '-mx-2 flex w-full items-center gap-2 rounded-control px-2 py-2.5 text-left transition-colors',
            to
              ? 'hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring'
              : '',
            risk.isPriority ? 'border border-brand-200 bg-brand-50/60' : '',
          ].join(' ')
          const rowContent = (
            <>
              <Badge
                tone={copy.severity === 'blocking' ? 'danger' : 'warning'}
                label={severityLabels[copy.severity]}
              />
              {actionLabel && <span className="sr-only">{actionLabel} — </span>}
              <span className="min-w-0 flex-1 truncate text-label font-medium text-text">{copy.text}</span>
              {risk.isPriority && <Badge tone="brand" label="우선 행동" />}
            </>
          )
          return (
            <li key={risk._key}>
              {to ? (
                <button type="button" className={rowClass} onClick={() => navigate(to)}>
                  {rowContent}
                </button>
              ) : (
                <div className={rowClass}>{rowContent}</div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default RiskList
