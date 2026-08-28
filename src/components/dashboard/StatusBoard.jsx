import { Button } from '../common/Button'
import { ErrorState } from '../common/ErrorState'
import { formatDurationKO } from '../../features/plan/planTime'

/*
  S1 · 이번 주 상태 보드 (DASH-01 + DASH-07 흡수 — ui-spec-dash.md §DASH.1, r2).
  The 3-state word/color table is FIXED by the (missing) decision doc's §4.5
  values, quoted verbatim in ui-spec-dash.md — this table is the only place
  that mapping lives, so a future copy tweak changes one object, not every
  call site.

  The status/percent/minutes are ALL server-decided (dry-run-style judgment,
  not something this component recomputes) — `status` alone drives the
  color/word and the progress bar's overload branch; the percent shown is
  plain arithmetic for display only, never used to re-derive `status` itself
  (ui-spec's "서버 판정 소비 — FE 재계산 금지").

  r2 delta (product-owner feedback, absorbing what r1 spread across two other
  cards): the [가용시간] button is gone. 손 볼 요일 (DASH-07) drops its own
  heading/divider sub-section and becomes the meta area's last line — same
  information, no longer reading as a separate card-within-a-card.

  dashboard-redesign delta (오너 목업): 손 볼 요일 줄이 위 여유/집중 줄과 다시
  한 줄로 합쳐진다 ("여유 {x} · 집중 {y} · 손 볼 요일 없음" 또는 칩) — 목업이
  메타 영역 전체를 한 줄로 그린다. 이 병합과 함께 "가용시간 조정 →" 텍스트
  링크도 목업에 없어 제거됐다(오너 확인) — /settings 진입은 이 카드가 아닌
  다른 도선이 계속 담당한다.

  계약 정합 delta (W6, 2026-08-23): 위 메타 줄(집중 시간 · 손 볼 요일)이
  통째로 빠졌다. `focusWindow`도 `adjustDays`도 실제 `DashboardView` 계약
  (openapi-live-76c7009.yaml)엔 없는 필드다 — 서버가 준 적 없는 값을 있는
  척 렌더하느니 그 줄 자체를 없앴다. `adjustDays`가 가리키던 DASH-07(요일별
  잔여 가용 %)은 계약에 `busyWeekdays`로 새로 생겼지만, 이번 작업 범위는
  데이터 계층에서 받아 두는 것까지다(dashboardApi.js 참고) — 이 카드에 다시
  그 줄을 그리는 건 별도 스토리.
*/
// TIGHT은 결정문 §4.5가 정의해 둔 세 번째 상태이지만, 실제 서버는 `status`
// 단어 자체를 안 주고 `deltaMinutes`의 부호만 준다(dashboardApi.js의
// normalizeStatusBoard 참고) — 부호 하나로는 OK/OVERLOAD 둘만 구분되므로
// TIGHT은 지금 어떤 입력으로도 선택되지 않는다. 미래에 실제 임계값이
// 계약에 추가되면 이 표는 그대로 두고 유도 함수만 갱신하면 된다.
const STATUS_COPY = {
  OK: { label: '무리 없음', textClass: 'text-text' },
  TIGHT: { label: '여유 부족', textClass: 'text-warning-700' },
  OVERLOAD: { label: '과부하', textClass: 'text-danger-700' },
}

export function StatusBoard({
  error = false,
  onRetry,
  status = 'OK',
  plannedMinutes = 0,
  availableMinutes = 0,
  onOpenWeekly,
}) {
  if (error) {
    return (
      <section>
        <h2 className="sr-only">이번 주 상태 보드</h2>
        <ErrorState variant="section" onAction={onRetry} />
      </section>
    )
  }

  const copy = STATUS_COPY[status] ?? STATUS_COPY.OK
  const overloaded = status === 'OVERLOAD'
  const percent = availableMinutes > 0 ? Math.round((plannedMinutes / availableMinutes) * 100) : 0
  const fillPercent = Math.min(Math.max(percent, 0), 100)
  const remainingMinutes = Math.max(availableMinutes - plannedMinutes, 0)
  const overMinutes = Math.max(plannedMinutes - availableMinutes, 0)
  // 오너 지시: 배너에 항상 보이던 "계획/가용" 서브라인과 메타의 "여유/초과"
  // 텍스트를 없애고, 두 값을 하나로 묶어 진행바에만 둔다 — hover(마우스)로는
  // 아래 툴팁 span으로, hover 없이도(스크린 리더·키보드) 이 문자열이 그대로
  // progressbar의 aria-label이 되어 항상 접근 가능하다(hover 단독 노출 금지).
  const timeDetailLabel = `${formatDurationKO(plannedMinutes)} / ${formatDurationKO(availableMinutes)} · ${
    overloaded ? `초과 ${formatDurationKO(overMinutes)}` : `여유 ${formatDurationKO(remainingMinutes)}`
  }`

  return (
    // md:relative + the CTA's md:absolute below: on desktop the button sits
    // top-right BESIDE the headline, matching PlanHeader's "카드/헤더 우상단
    // 액션" system (size sm there too). Mobile keeps it in normal flow, full
    // width, size lg (48px — the one CTA left still needs the mobile touch
    // target ui-spec §0.4 requires; sm/md would violate it there).
    <div className="rounded-card border border-border bg-surface p-4 md:relative md:p-5">
      {/* 배너 레이아웃(오너 지시 — 대시보드가 단일 컬럼 세로 스택으로
          바뀌면서 이 카드가 전체 폭을 받게 됐고, 예전의 좁은 세로 배치는
          가로로 허전해 보였다). md 이상에서 헤드라인 블록(고정폭)과 진행바가
          가로로 나란히 서고, 모바일에선 그냥 위/아래로 쌓인다. md:pr-40은
          그대로 우상단 CTA 자리를 비워두는 용도 — 이 row 전체가 CTA 쪽으로
          번지지 않게 한다(이전에는 헤드라인 블록 하나에만 걸려 있던 걸 이제
          row 전체로 옮겼을 뿐, 같은 트릭). */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:gap-8 md:pr-40">
        <div className="md:w-60 md:shrink-0">
          <p className="flex items-baseline gap-2">
            <span className={`text-display font-bold ${copy.textClass}`}>{copy.label}</span>
            <span className="text-title text-text-muted tabular-nums">{percent}%</span>
          </p>
        </div>

        <div className="min-w-0 flex-1">
          {/* 오너 지시(데스크톱 전용 — 모바일은 그냥 세로로 쌓이므로 정렬
              문제 자체가 없다): 진행바 "자체"의 세로 중심이 왼쪽 헤드라인
              (무리없음/%)과 나란해야 한다 — 스케일 줄(0/가용)까지 포함해서
              정렬하면 그 무게가 아래로 쏠려 막대가 시각적으로 위쪽에 붙어
              보인다. 그래서 md 이상에서만 스케일 줄을 `group relative`
              래퍼(=막대 자신, h-2) 기준 `absolute`로 빼서 flex 정렬 계산엔
              막대만 참여시킨다 — 부모 row의 `md:items-center`가 이제 정확히
              "막대 중심 = 헤드라인 중심"이 되게 센터를 맞춘다. 모바일에서는
              `md:` 접두가 없는 기본 상태(static, 정상 흐름)라 스케일 줄이
              원래대로 막대 바로 아래 공간을 실제로 차지한다 — 그래서
              데스크톱만 고치고 모바일 간격은 그대로다. `tabIndex` 없이는 이
              div가 포커스를 못 받아 키보드 사용자가 hover 전용 정보에서
              소외되므로(WCAG 2.1.1) 반드시 focusable로 만든다 —
              focus-visible 링도 그래서 붙는다. */}
          <div className="group relative">
            <div
              role="progressbar"
              tabIndex={0}
              aria-valuenow={fillPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={timeDetailLabel}
              className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              {/* dashboard-redesign (오너 목업): 기본 fill이 neutral-800 대신
                  brand-600(파란색) — OVERLOAD 판정만은 그대로 danger로 남겨
                  "위험" 신호를 색으로도 구분한다(NFR-017 — 텍스트 라벨
                  "과부하"가 이미 색 단독이 아니게 병기하므로, 여기 색은 강화
                  신호일 뿐). */}
              <div
                className={`h-full rounded-full ${overloaded ? 'bg-danger-600' : 'bg-brand-600'}`}
                style={{ width: `${fillPercent}%` }}
              />
            </div>

            {/* 0/가용 스케일 — md 이상에서만 절대 배치(막대 정렬 계산에서
                빠지도록), 모바일은 기본값(static, 정상 흐름)이라 막대 아래
                실제 공간을 차지한다. 시각적 위치는 두 경우 다 막대 바로
                아래(mt-1)로 동일하다. */}
            <div className="mt-1 flex justify-between text-caption text-text-muted tabular-nums md:absolute md:inset-x-0 md:top-full">
              <span>0</span>
              <span>{formatDurationKO(availableMinutes)}</span>
            </div>

            {/* Hover/focus 툴팁 — WbsTimeline의 드래그 툴팁과 같은
                floating-chip 스타일(rounded-control + bg-neutral-900/70 +
                shadow-popover)을 재사용. 오프셋도 반응형이다: 모바일은
                스케일 줄이 정상 흐름이라 `top-full`이 이미 스케일 줄 아래를
                가리켜 `mt-2`면 충분하지만, md 이상은 스케일 줄이 절대
                배치라 `top-full`이 막대 바로 아래만 가리키므로 스케일 줄
                높이만큼 더 내려야 한다(`md:mt-7`). `aria-hidden`: 같은
                내용이 위 progressbar의 aria-label에 이미 있어, 이 span까지
                읽으면 스크린 리더가 두 번 읽게 된다 — 여긴 마우스 사용자를
                위한 시각적 강화일 뿐이다. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 -translate-x-1/2 whitespace-nowrap rounded-control bg-neutral-900/70 px-2 py-1 text-caption text-white opacity-0 shadow-popover transition-opacity duration-fast ease-standard group-hover:opacity-100 group-focus-within:opacity-100 md:mt-7"
            >
              {timeDetailLabel}
            </span>
          </div>
        </div>
      </div>

      {/* CTA: normal-flow full-width row on mobile; pinned to the card's
          top-right corner on desktop (md:relative on the card above makes
          this absolute positioning relative to the CARD, not the viewport).
          variant="outline"(흰 배경 + 파란 글씨, 오너 목업) — 이전엔 primary
          (brand 솔리드 채움)였다. */}
      {/* 🔴 숨김 클래스를 Button에 직접 주지 말 것 (오너 보고 2026-08-28 —
          모바일 폭에서 "주간 계획 확인"이 두 개 보였다).

          Button은 자기 기본 클래스에 `inline-flex`를 항상 붙인다. 전달한
          `hidden`과 `inline-flex`는 특이도가 같아 **CSS에 나중에 나온 쪽이
          이기는데**, 빌드된 스타일시트에서 `.inline-flex`가 `.hidden`보다
          뒤에 온다(실측: hidden 13071바이트 / inline-flex 13150바이트).
          그래서 `hidden md:inline-flex`를 준 데스크톱 버튼이 모바일에서도
          그려졌다. 반대쪽(`md:hidden`)이 멀쩡했던 것은 반응형 변형이
          기본 유틸리티보다 뒤에 출력되기 때문일 뿐, 같은 함정이다.

          그래서 표시/숨김은 경쟁 클래스가 없는 래퍼가 맡는다. Button에는
          레이아웃 클래스(`w-full`)만 남긴다. */}
      <div className="mt-4 md:absolute md:right-5 md:top-5 md:mt-0">
        <div className="md:hidden">
          <Button variant="outline" size="lg" className="w-full" onClick={onOpenWeekly}>
            주간 계획 확인
          </Button>
        </div>
        <div className="hidden md:block">
          <Button variant="outline" size="sm" onClick={onOpenWeekly}>
            주간 계획 확인
          </Button>
        </div>
      </div>
    </div>
  )
}

export default StatusBoard
