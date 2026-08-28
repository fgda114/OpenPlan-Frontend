import { Link } from 'react-router-dom'
import { Badge } from '../common/Badge'
import { Button } from '../common/Button'
import { ErrorState } from '../common/ErrorState'
import { CheckCircleIcon } from '../common/statusIcons'
import { useIsDesktop } from '../../hooks/useMediaQuery'
import { formatDurationKO } from '../../features/plan/planTime'

/*
  S3 · 오늘 할 일 (DASH-05 · RB-DASH-02 — ui-spec-dash.md §DASH.3, r2). Row order
  and the "오늘 먼저" pick are BOTH server-decided (RB-DASH-02's priority/deadline/
  status rule) — this component only renders what it's given, never re-sorts.
  r2 moved this card beside the status board (HomePage.jsx's DashboardLayout)
  and changed [기록]'s mobile size sm→lg (touch target — matches RiskList's
  precedent below).

  dashboard-redesign delta (오너 목업, 2 rounds):
  - "주간 계획에서 보기 →" moved from its own footer row into the header,
    relabeled "전체 보기 →" — same /weekly destination, just relocated.
  - `dateLabel` (예: "5월 6일 화요일") no longer renders here at all — the
    dashboard's own PageHeader already shows the week caption, so this was a
    second on-screen date for the same info (오너 지적, round 2). Originally
    this was "still arrives from the API, component just stops consuming it";
    since then the real `DashboardView` contract (W6, 2026-08-23) confirmed
    `todayBoard` never had a `dateLabel` field to begin with — so this is now
    simply a field that doesn't exist, not one this component chooses to
    ignore. No prop, no render, nothing upstream to keep in sync either.
  - [취소] button added — NOT beside [기록] (round-2 오너 정정: an unlogged
    item only offers [기록]; [취소] appears once an item IS logged, replacing
    the plain "완료" text-only state with "완료" + a way to undo it). Its
    wiring isn't decided yet — see the honesty fix below (W6, 2026-08-28).
  - "오늘 먼저" badge moved from the FRONT of the row to the END, after the
    title (오너 목업 순서: [시간] [제목] [오늘 먼저]). Also switched from a
    locally-styled span to `<Badge tone="brand" />` — ST-F1-08 landed the
    `brand` tone on the shared Badge atom since this component was first
    written, so the local stand-in is no longer needed (same visual anatomy,
    now the real shared component).
*/

/*
  취소 버튼 — 계약 부재로 정직하게 비활성화 (W6, 2026-08-28, 리드 확인).
  이전엔 아무 일도 안 하면서 "취소되었습니다" 토스트만 띄우는 스텁이었다 —
  사용자는 취소된 줄 알고 넘어가지만 서버 상태는 그대로였다(침묵보다 나쁜
  거짓 성공 피드백). 리드가 계약을 확인한 결과 실행 기록을 취소·삭제하는
  엔드포인트가 없다(`execution-logs`는 POST만 존재) — 즉 지금은 구현할
  방법 자체가 없다. 그래서 버튼을 감추는 대신 `disabled` +
  `disabledReason`으로 "왜 못 쓰는지"를 항상 보이는 텍스트로 남긴다
  (Button.jsx의 disabledReason은 hover 툴팁이 아니라 caption으로 렌더되어
  키보드/스크린리더 사용자도 이유를 알 수 있다 — SYS-07 §7.2 선례와 동일).
  서버에 취소 엔드포인트가 생기면 이 disabled를 걷어내고 실제 뮤테이션을
  onClick에 연결하면 된다 — 버튼/레이아웃은 이미 갖춰져 있다.
*/
const CANCEL_DISABLED_REASON = '아직 지원하지 않는 기능입니다'

export function TodayBoard({
  error = false,
  onRetry,
  expectedMinutes = 0,
  remainingAvailableMinutes = 0,
  items = [],
  canWrite = true,
  offlineReason,
  onLog,
}) {
  const isDesktop = useIsDesktop()

  if (error) {
    return (
      <section>
        <h2 className="mb-2 text-title font-semibold text-text">오늘 할 일</h2>
        <ErrorState variant="section" onAction={onRetry} />
      </section>
    )
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-title font-semibold text-text">오늘 할 일</h2>
        {/* "전체 보기" 진입점을 헤더 우상단에 둔다(오너 목업) — 예전엔 목록
            아래 별도 줄이었다. 날짜는 더 이상 여기 렌더하지 않는다(round 2) —
            대시보드 PageHeader의 주차 캡션과 같은 정보가 중복 노출이었다. */}
        <Link
          to="/weekly"
          className="rounded text-label font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          전체 보기 →
        </Link>
      </div>
      <p className="mt-1 text-label text-text-muted tabular-nums">
        예상 {formatDurationKO(expectedMinutes)} · 남은 가용 {formatDurationKO(remainingAvailableMinutes)}
      </p>

      <div className="mt-3 border-t border-border" />

      {items.length === 0 ? (
        <p className="py-4 text-label text-text-muted">오늘 예정된 항목이 없습니다.</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2.5">
              {/* Fixed-width slot whether or not the check renders, so titles
                  align between completed and incomplete rows (no text jump). */}
              <span className="flex w-5 shrink-0 justify-center">
                {item.completed && <CheckCircleIcon className="text-text-muted" size={18} />}
              </span>
              <div className={`min-w-0 flex-1 ${item.completed ? 'text-text-muted' : ''}`}>
                {/* 순서: [시간] [제목] [오늘 먼저] — 배지가 제목 뒤로 온다
                    (오너 목업, round 2. 이전엔 맨 앞이었다). */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-label font-medium tabular-nums">{item.timeLabel}</span>
                  <span className="text-label line-clamp-1">
                    {item.title}
                    {item.type === 'SCHEDULE' && <span className="text-text-muted"> (일정)</span>}
                  </span>
                  {item.isTop && !item.completed && <Badge tone="brand" label="오늘 먼저" />}
                </div>
                <p className="mt-0.5 text-caption text-text-muted tabular-nums">
                  {item.completed ? '완료' : `예상 ${formatDurationKO(item.expectedMinutes)}`}
                </p>
              </div>
              {/* 미기록 항목엔 [기록]만, 이미 기록된 항목엔 [취소]만(round-2
                  오너 정정 — 둘이 같은 행에 같이 뜨는 조합은 없다). Desktop
                  sm / mobile lg (48px touch target — ui-spec §0.4).

                  [기록] only renders for a row that actually HAS a taskId
                  (a TASK-type row) — a SCHEDULE-type row (item.type ===
                  'SCHEDULE', e.g. "스터디" above) has no backing task at all,
                  so there is nothing PLAN-15's execution-record endpoint could
                  attach to. Before this, [기록] rendered active regardless of
                  type; clicking it on a SCHEDULE row called onLog with
                  `item.taskId === undefined`, which the mock silently accepted
                  but a real backend would 404/400 on
                  (`POST /tasks/undefined/execution-records`). Hidden rather
                  than disabled: unlike the offline case below, this isn't a
                  transient condition a disabledReason tooltip would explain
                  away — this row structurally never gets a [기록] action. */}
              <div className="flex shrink-0 items-center gap-2">
                {item.completed ? (
                  // 항상 disabled — 취소를 수행할 서버 엔드포인트가 없다(위
                  // 헤더 주석 참고). 오프라인일 땐 그 사유를 우선 보여준다
                  // (더 급한 정보 — 온라인이어도 어차피 못 쓰는 건 매한가지).
                  <Button
                    variant="secondary"
                    size={isDesktop ? 'sm' : 'lg'}
                    disabled
                    disabledReason={!canWrite ? offlineReason : CANCEL_DISABLED_REASON}
                  >
                    취소
                  </Button>
                ) : (
                  item.taskId != null && (
                    <Button
                      variant="secondary"
                      size={isDesktop ? 'sm' : 'lg'}
                      disabled={!canWrite}
                      disabledReason={!canWrite ? offlineReason : undefined}
                      onClick={() => onLog?.(item)}
                    >
                      기록
                    </Button>
                  )
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default TodayBoard
