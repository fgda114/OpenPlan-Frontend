import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { PlanHeader } from '../components/plan/PlanHeader'
import { WeekNav } from '../components/plan/WeekNav'
import { SummaryBar } from '../components/plan/SummaryBar'
import { CalendarGrid } from '../components/plan/CalendarGrid'
import { UndoRedo } from '../components/plan/UndoRedo'
import { PlanFab } from '../components/plan/PlanFab'
import { BlockActionMenu } from '../components/plan/BlockActionMenu'
import { ReviewPanel } from '../components/plan/ReviewPanel'
import { UnplacedPanel } from '../components/plan/UnplacedPanel'
import { AutoPlaceBar } from '../components/plan/AutoPlaceBar'
import { ScheduleForm } from '../components/plan/ScheduleForm'
import { ExecutionLogForm } from '../components/plan/ExecutionLogForm'
import { SaveConfirmDialog } from '../components/plan/SaveConfirmDialog'
import { ReplanOptionsModal } from '../components/plan/ReplanOptionsModal'
import { TaskEditModal } from '../components/task/TaskEditModal'
import { ErrorState } from '../components/common/ErrorState'
import {
  useApplyAutoPlace,
  useApplyReplanOption,
  useAutoPlace,
  useAvailability,
  useCreateScheduleBlock,
  useFixedSchedules,
  useLogExecution,
  useMoveBlock,
  usePlaceTask,
  usePlanValidation,
  useRemoveBlockWithUndo,
  useReplanOptions,
  useResizeBlock,
  useSaveAvailability,
  useSaveWeek,
  useSetBlockComplete,
  useToggleFixedException,
  useUnplacedTasks,
  useUpdateSchedule,
  useWeekPlan,
} from '../features/plan/usePlanData'
import { severityLabels } from '../features/plan/violationMessages'
import { BASELINE_STRATEGY_TYPE } from '../features/plan/replanStrategies'
import {
  usePlanHistory,
  selectCanUndo,
  selectCanRedo,
} from '../features/plan/usePlanHistory'
import { usePlacementDrag } from '../features/plan/usePlacementDrag'
import { resolveGridSlot, visibleRange } from '../features/plan/planGeometry'
import { findFirstFreeSlot } from '../features/plan/planPlacement'
import { getPopoverAnchorStyle } from '../utils/popoverPosition'
import {
  addWeeksISO,
  clampBlockSpan,
  composeTimestamp,
  currentWeekStartISO,
  dateOf,
  isPastWeek,
  MINUTES_PER_DAY,
  minutesOfDay,
  snapDuration,
  WEEKDAY_KEYS,
  weekDays as weekDaysOf,
} from '../features/plan/planTime'
import { useAppStore, selectCanWrite } from '../store/useAppStore'
import { toast } from '../hooks/useToasts'
import { systemMessages } from '../constants/systemMessages'

// How long the PLAN-23 highlight stays on a block: two pulses of --duration-slow
// (320ms) plus a beat, so the ring is gone shortly after the animation ends
// instead of lingering as a permanent marker.
const FOCUS_HIGHLIGHT_MS = 900

// Sum of active availability windows across the week = the "available" total the
// summary bar compares planned time against (PLAN-01).
function availableMinutesOf(availability) {
  return (availability ?? [])
    .filter((a) => a.isActive)
    .reduce((sum, a) => sum + (a.endMinutes - a.startMinutes), 0)
}

/*
  ST-F1-02 orchestrator. Wires the read view (week query + prefetch, summary,
  mode toggle) to the write interactions (drag/keyboard move, undo/redo,
  availability edit) via the feature hooks. Cross-cutting concerns each stay in
  their own module: server state in TanStack Query, undo stack in usePlanHistory,
  drag geometry in usePlanDrag/CalendarGrid.
*/
/*
  자동 배치 초안에 제목을 잇는다. 서버 응답(openapi PlacementProposal.proposedBlocks)은
  계약상 blockType·taskId·startAt·endAt 만 싣고 제목이 없는데, 격자의 초안 블록은
  `title` 로 그린다. 그래서 방금 읽어 둔 미배치 목록에서 taskId 로 찾아 얹는다.
*/
function withDraftTitles(draft, unplacedTasks) {
  const titleById = new Map((unplacedTasks ?? []).map((t) => [t.taskId, t.title]))
  return {
    ...draft,
    placements: (draft?.placements ?? []).map((p) => ({ ...p, title: titleById.get(p.taskId) ?? '' })),
  }
}

function WeeklyPage() {
  // Read early: ST-F1-07's `?openReplan=1` seam (below) needs this to seed
  // `replanOpen`'s OWN initial state directly, rather than an Effect that
  // mirrors the URL into it after the fact.
  const [searchParams, setSearchParams] = useSearchParams()

  const [weekStartISO, setWeekStartISO] = useState(() => currentWeekStartISO())
  const [mode, setMode] = useState('focus')
  const [menu, setMenu] = useState({ open: false, block: null, position: null })
  const [reviewOpen, setReviewOpen] = useState(false)

  // ST-F1-03: unplaced panel + auto-place draft + empty-slot task picker.
  //
  // plan-polish seams (ST-F1-08/10 entry points): `?openUnplaced=1` (dashboard's
  // "지금 배치하기") opens the panel outright; `?project={id}` (PROJ-15/19, a
  // project screen) opens it PRE-FILTERED, per the panel's own existing PROJ-15
  // doc comment on `projectId` below — filtering while the panel stays closed
  // would be invisible, so either param alone opens it, and they combine fine
  // (`?openUnplaced=1&project=xxx`) since both just seed independent state.
  // Read directly into these two states' own lazy initializers (not mirrored
  // via an Effect) — same reasoning `?openReplan=1` already uses below; the
  // params are stripped from the URL once, further down, so a refresh never
  // reopens/refilters.
  const initialProjectFilter = searchParams.get('project') || null
  const [panelOpen, setPanelOpen] = useState(
    () => searchParams.get('openUnplaced') === '1' || Boolean(initialProjectFilter),
  )
  const [projectFilter, setProjectFilter] = useState(() => initialProjectFilter)
  const [autoDraft, setAutoDraft] = useState(null) // { placements, unplaced } | null
  const [slotMenu, setSlotMenu] = useState(null) // { point, slot } | null

  // ST-F1-04 Phase 2: schedule form (create/edit) + execution log.
  const [scheduleForm, setScheduleForm] = useState(null) // { mode, block?, slot? } | null
  const [execLog, setExecLog] = useState(null) // { block } | null

  // ST-F1-09 (owner review, modal decision): "태스크 편집" opens TaskEditModal
  // with the BLOCK's own taskId — a plan-store id (`plan-task-*`), which
  // projectApi.getTask can never resolve (see that function's own
  // cross-store-gap comment). The modal itself renders a graceful in-modal
  // "태스크를 찾을 수 없습니다" for that case — this page doesn't need to
  // special-case it, only open/close the modal like any other one here.
  const [taskEditTaskId, setTaskEditTaskId] = useState(null)

  // ST-F1-05: the block PLAN-23 asked to focus, and the warnings-only save confirm.
  const [focusRequest, setFocusRequest] = useState(null) // { planBlockId, token } | null
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false)

  // ST-F1-07: the replan-alternatives modal. `applyConflict` is set only by a
  // 409 on apply (AC-3 "다시 생성 유도") — it forces a regenerate before another
  // apply attempt is allowed (see handleApplyReplan / closeReplan below).
  //
  // Trigger #2 of 2 (AC-4): the dashboard's risk card (ST-F1-10) doesn't exist
  // yet, so `?openReplan=1` is the seam it will use once it does — read ONCE,
  // directly, as this state's own lazy initializer (not an Effect mirroring the
  // URL into it: React docs' own "you might not need an Effect" case for this
  // exact shape). The param is stripped from the URL separately below, so a
  // refresh of this same page never reopens it.
  const [replanOpen, setReplanOpen] = useState(() => searchParams.get('openReplan') === '1')
  const [applyConflict, setApplyConflict] = useState(false)

  const gridBodyRef = useRef(null)
  const unplacedPanelRef = useRef(null)
  // Pending "take the highlight back down" timer (PLAN-23); see handleSelectIssue.
  const focusClearTimerRef = useRef(null)

  // Don't let that timer fire into an unmounted page.
  useEffect(() => () => clearTimeout(focusClearTimerRef.current), [])

  // plan-polish: the desktop unplaced panel's vertical bounds. It used to be a
  // fixed `top` + a vh-relative max-height, which could sit right over the
  // auto-place bar's [적용] button. Anchored instead between two REAL layout
  // landmarks, read via getBoundingClientRect (viewport-relative — matches the
  // panel's own `position: fixed`):
  //   top    = gridWrapperRef's top — right below the SummaryBar wrapper.
  //   bottom = floatingControlsRef's bottom — the UndoRedo/FAB row, which is
  //            bottom-anchored by CSS (`bottom-6`/`bottom-18`) so its rect stays
  //            put even while the FAB child itself unmounts (it hides whenever
  //            this same panel is open — see the render below).
  //
  // (fix E note: this used to also branch on `autoDraft` and cache/estimate
  // AutoPlaceBar's height, because the grid's own top moved depending on
  // whether the bar was showing. Now that the bar is an overlay — see its
  // render below — the grid's top is invariant to `autoDraft` by construction,
  // so that branching/caching is gone; a plain, single measurement is correct.)
  const gridWrapperRef = useRef(null)
  const floatingControlsRef = useRef(null)
  const [panelBounds, setPanelBounds] = useState(null) // { top, height } | null until measured

  useLayoutEffect(() => {
    const measure = () => {
      const top = gridWrapperRef.current?.getBoundingClientRect().top
      const bottom = floatingControlsRef.current?.getBoundingClientRect().bottom
      if (top == null || bottom == null) return
      // Floors the height so a measurement race (or a pathologically short
      // viewport) can never hand the panel a collapsed or negative max-height.
      setPanelBounds({ top, height: Math.max(bottom - top, 240) })
    }
    measure()
    // Resize is the only thing that can move these landmarks without this
    // component re-rendering on its own — e.g. WeekNav/SummaryBar text
    // reflowing at a narrower width. No ResizeObserver/scroll listener: the
    // page's own scroll container is document-level, and the anchors' HEIGHT
    // (not position within a scrolling ancestor) is what changes here, which a
    // resize listener already covers.
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const planQuery = useWeekPlan(weekStartISO)
  const availQuery = useAvailability()
  const fixedSchedulesQuery = useFixedSchedules(weekStartISO)
  const toggleFixedException = useToggleFixedException()
  const moveBlock = useMoveBlock()
  const saveAvailability = useSaveAvailability()
  // Fetch the FULL backlog (no server projectId filter); the panel filters by
  // project CLIENT-SIDE so every project chip stays visible even while one is
  // selected. (PROJ-15/19 entry just preselects projectFilter — same list.)
  const unplacedQuery = useUnplacedTasks()
  const placeTask = usePlaceTask()
  const autoPlace = useAutoPlace()
  const applyAutoPlace = useApplyAutoPlace()
  const setBlockComplete = useSetBlockComplete()
  const removeBlock = useRemoveBlockWithUndo()
  const resizeBlock = useResizeBlock()
  const logExecution = useLogExecution()
  const createSchedule = useCreateScheduleBlock()
  const updateSchedule = useUpdateSchedule()
  const saveWeekPlan = useSaveWeek()
  // planQuery.data (not the `plan` alias below, which isn't declared yet at this
  // point in the component) — same underlying value either way.
  //
  // Destructured (not read as `replanOptions.generate` etc. at each call site)
  // because react-hooks/exhaustive-deps cannot verify the STABILITY of a member
  // expression used as a dependency — it would demand the whole `replanOptions`
  // object, which is a fresh literal every render and would re-fire the open
  // effect below on every render. Destructuring hands the effect a plain local
  // binding the rule CAN verify (these are individually memoized in
  // useReplanOptions — generate/retry/reset are useCallback'd on `weeklyPlanId`
  // alone, a stable primitive here), so the dependency array stays honest with
  // no eslint-disable.
  const {
    byType: replanStrategies,
    generate: generateReplanOptions,
    retry: retryReplanOption,
    reset: resetReplanOptions,
    isGenerating: replanGenerating,
    slowNotice: replanSlowNotice,
  } = useReplanOptions(planQuery.data?.weeklyPlanId)
  const applyReplanOption = useApplyReplanOption()
  const navigate = useNavigate()

  const history = usePlanHistory()
  const canUndo = usePlanHistory(selectCanUndo)
  const canRedo = usePlanHistory(selectCanRedo)
  const canWrite = useAppStore(selectCanWrite)

  const plan = planQuery.data
  const availability = useMemo(() => availQuery.data ?? [], [availQuery.data])
  // Memoized because the validation loop debounces on this array's IDENTITY: an
  // inline `plan?.blocks ?? []` would be a new array every render and would keep
  // rescheduling the debounce forever (see usePlanValidation).
  const blocks = useMemo(() => plan?.blocks ?? [], [plan])
  const readOnly = isPastWeek(weekStartISO)
  // plan-polish fix G: an auto-place DRAFT freezes every OTHER block the same
  // way a past week does — moving/resizing/deleting one while it's under
  // review would invalidate the block set the draft's placements were
  // computed against, so [적용] could commit a batch that no longer matches
  // what's on screen. `readOnly` keeps its OWN narrower meaning (used verbatim
  // by PlanHeader's "지난 주간 계획" banner and other past-week-SPECIFIC copy,
  // which would be actively wrong to show during a draft review on the
  // CURRENT week) — `planLocked` is the wider "can't edit right now" gate
  // reused everywhere CalendarGrid/UnplacedPanel/the move-commit path already
  // gated on bare `readOnly`, extending (not duplicating) those same gates
  // rather than building a parallel lock system (see CalendarGrid's `readOnly`
  // prop below, and PlanBlock's `disabled`/`moveLocked` split from AC-5, which
  // already exists for exactly this kind of "locked, but not EVERYTHING" case).
  const planLocked = readOnly || Boolean(autoDraft)
  // Badge count = the unplaced LIST length (single source), not the per-week
  // plan.unplacedCount (which is cached per week and can go stale — Thomas HIGH).
  const unplacedCount = unplacedQuery.data?.length ?? 0

  const days = useMemo(() => weekDaysOf(weekStartISO), [weekStartISO])
  const range = useMemo(() => visibleRange(mode, availability), [mode, availability])
  const availableMinutes = availableMinutesOf(availability)

  // --- validation (ST-F1-05: PLAN-21~28) ------------------------------------

  // A past week is read-only, so there is nothing to validate and nothing to save.
  const validation = usePlanValidation({
    weeklyPlanId: plan?.weeklyPlanId,
    blocks,
    enabled: !readOnly,
  })

  // Until the first dry-run answers, fall back to the counts the week payload
  // carries. Showing "0 위반" for the ~400ms before the first result would be a
  // brief lie in exactly the direction that matters (it implies "safe to save").
  const blockingCount = validation.hasResult
    ? validation.blockingCount
    : (plan?.validation?.blockCount ?? 0)
  const warningCount = validation.hasResult
    ? validation.warningCount
    : (plan?.validation?.warningCount ?? 0)
  // W3 2차 리뷰 (ADR-0013 "savable = 차단 0건"): the save gate now defers to the
  // SERVER's own verdict (validation.savable — planApi.normalizeValidationPayload
  // already prefers it over a derived count, see that function's header) rather
  // than re-deriving "차단이 있는가" from blockingCount itself. Before the first
  // dry-run answers, mirrors blockingCount's own pre-result fallback (the week
  // payload's cached blockCount) for the identical reason: not knowing yet must
  // not read as "safe to save".
  const savable = validation.hasResult
    ? validation.savable
    : (plan?.validation?.blockCount ?? 0) === 0

  /*
    Layer 1 input: the worst severity per block plus how many issues it carries.
    One block can appear in several issues (an overlap that is ALSO outside the
    availability window), and the block only has room for one chip — 차단 wins,
    and the count tells the user there is more to read in the panel.
  */
  const violationsByBlockId = useMemo(() => {
    const marks = {}
    for (const issue of validation.issues) {
      for (const blockId of issue.targetBlockIds) {
        const existing = marks[blockId]
        if (!existing) {
          marks[blockId] = {
            severity: issue.severity,
            label: severityLabels[issue.severity],
            count: 1,
          }
          continue
        }
        existing.count += 1
        if (issue.severity === 'blocking' && existing.severity !== 'blocking') {
          existing.severity = 'blocking'
          existing.label = severityLabels.blocking
        }
      }
    }
    return marks
  }, [validation.issues])

  const warningIssues = useMemo(
    () => validation.issues.filter((i) => i.severity !== 'blocking'),
    [validation.issues],
  )

  /*
    PLAN-23. The panel names a target; the block does the scrolling and focusing
    (only it knows its DOM node). The panel is CLOSED first on every breakpoint,
    not just mobile: both shells are focus-trapped modals, so leaving it open
    would either swallow the focus move or leave focus inside an overlay covering
    the block the user just asked to see.
  */
  const handleSelectIssue = (issue) => {
    const target = blocks.find((b) => issue.targetBlockIds.includes(b.planBlockId))
    setReviewOpen(false)
    if (!target) {
      toast({ tone: 'info', message: '이 항목의 대상 블록을 찾을 수 없습니다' })
      return
    }

    // A 가용 시간 밖 block (V5) is, by definition, often outside what focus mode
    // renders — scrolling to a block that isn't in the DOM looks like the panel
    // did nothing. Widen to 24h first so there is something to scroll to.
    const startMin = minutesOfDay(target.startAt)
    const endMin = minutesOfDay(target.endAt)
    if (startMin < range.startMinutes || endMin > range.endMinutes) setMode('24h')

    // A counter, not the id: re-selecting the SAME block must retrigger the
    // scroll/focus/pulse, which only a changed value can do.
    setFocusRequest((prev) => ({ planBlockId: target.planBlockId, token: (prev?.token ?? 0) + 1 }))

    // The highlight is an ANNOUNCEMENT, not a selection state, so it has to be
    // taken back down: the ring is rendered as long as focusRequest names this
    // block, and a CSS animation reverts to its base style when it ends rather
    // than staying at its final keyframe. Clearing here covers both the animated
    // and the reduced-motion (static ring) paths with one rule.
    clearTimeout(focusClearTimerRef.current)
    focusClearTimerRef.current = setTimeout(() => setFocusRequest(null), FOCUS_HIGHLIGHT_MS)
  }

  // --- move (drag/keyboard) → optimistic PATCH + history --------------------

  // Turn a grid target into absolute timestamps + a target week key.
  const resolveTarget = ({ boundary, dayIndex, startMin, endMin }) => {
    const targetWeek =
      boundary === 'prev'
        ? addWeeksISO(weekStartISO, -1)
        : boundary === 'next'
          ? addWeeksISO(weekStartISO, 1)
          : weekStartISO
    const dayISO = weekDaysOf(targetWeek)[dayIndex]
    return {
      targetWeek,
      startAt: composeTimestamp(dayISO, startMin),
      endAt: composeTimestamp(dayISO, endMin),
    }
  }

  const applyMove = ({ planBlockId, startAt, endAt, sourceWeek, targetWeek }) => {
    moveBlock({ planBlockId, startAt, endAt, sourceWeek, targetWeek })
  }

  // A user-initiated move: commit it AND push an undo entry.
  //
  // plan-polish (PLAN-20 follow-up): every week-crossing move — the drag's own
  // boundary commit, keyboard nudge past a day edge (CalendarGrid's makeNudge),
  // and the menu's "다음/이전 주로 이동" (below) — funnels through here, so this
  // one guard covers all three rather than teaching each caller its own check.
  // A block moved INTO a past week would land somewhere read-only, with no way
  // back except the very move just blocked (past weeks disable dragging AND
  // this menu item — see menuItemsFor) — reject it here instead. The CURRENT
  // week is never "past" (isPastWeek excludes it), so a move back from a
  // future week to the present still goes through untouched.
  const handleUserMove = (target) => {
    const block = blocks.find((b) => b.planBlockId === target.planBlockId)
    if (!block) return
    // fix G: the primary defense is upstream (usePlanDrag's disabled, PlanBlock's
    // moveBlocked, the menu simply omitting move items — all fed by planLocked
    // below), but this is the ONE choke point every move path funnels through
    // (drag, keyboard nudge, and the menu's move-to-adjacent-week), so it gets
    // its own check too rather than trusting three separate UI gates to agree.
    if (planLocked) return
    const { targetWeek, startAt, endAt } = resolveTarget(target)
    if (isPastWeek(targetWeek)) {
      // No cache write happens, so the block's dragState (already cleared by
      // usePlanDrag's handleUp by the time this runs) leaves it rendering at
      // its untouched, pre-drag position — this toast is the only thing that
      // tells the user the drop DID register, rather than silently no-op-ing.
      toast({ tone: 'info', message: '지난 주로는 블록을 이동할 수 없습니다' })
      return
    }
    applyMove({ planBlockId: target.planBlockId, startAt, endAt, sourceWeek: weekStartISO, targetWeek })
    history.record({
      type: 'move',
      planBlockId: target.planBlockId,
      before: { startAt: block.startAt, endAt: block.endAt, week: weekStartISO },
      after: { startAt, endAt, week: targetWeek },
    })
  }

  // ST-F1-04 PLAN-20 menu entry (plan-polish): reuses handleUserMove — the SAME
  // optimistic PATCH + undo-record path dragging a block across a week edge
  // already takes — rather than a new one. Only the week changes: dayIndex/
  // startMin/endMin come straight off the block's OWN current position (`days`
  // is THIS week's column list, so `days.indexOf` gives back the same column
  // index resolveTarget will re-apply to the target week — same weekday, same
  // time either side of the move).
  const moveBlockToAdjacentWeek = (block, boundary) => {
    const dayIndex = days.indexOf(dateOf(block.startAt))
    if (dayIndex < 0) return
    handleUserMove({
      planBlockId: block.planBlockId,
      boundary,
      dayIndex,
      startMin: minutesOfDay(block.startAt),
      endMin: minutesOfDay(block.endAt),
    })
  }

  // The stack now holds two entry shapes (a 'move' generalization — see
  // usePlanHistory's header): 'move' entries are replayed here through the same
  // optimistic PATCH a drag uses; 'remove' entries (unplace/delete) already carry
  // their own undo/redo closures from useRemoveBlockWithUndo, so we just call them.
  const handleUndo = () => {
    const entry = history.undo()
    if (!entry) return
    if (entry.type === 'remove') {
      entry.undo()
      return
    }
    applyMove({
      planBlockId: entry.planBlockId,
      startAt: entry.before.startAt,
      endAt: entry.before.endAt,
      sourceWeek: entry.after.week,
      targetWeek: entry.before.week,
    })
  }

  const handleRedo = () => {
    const entry = history.redo()
    if (!entry) return
    if (entry.type === 'remove') {
      entry.redo()
      return
    }
    applyMove({
      planBlockId: entry.planBlockId,
      startAt: entry.after.startAt,
      endAt: entry.after.endAt,
      sourceWeek: entry.before.week,
      targetWeek: entry.after.week,
    })
  }

  // --- availability edge drag (PLAN-32) -------------------------------------

  const handleAvailabilityCommit = (columnIndex, edge, minutes) => {
    const key = WEEKDAY_KEYS[columnIndex]
    const next = availability.map((a) => {
      if (a.weekday !== key) return a
      // Keep start < end with a 5-minute floor between them.
      if (edge === 'start') return { ...a, startMinutes: Math.min(minutes, a.endMinutes - 5) }
      return { ...a, endMinutes: Math.max(minutes, a.startMinutes + 5) }
    })
    saveAvailability.mutate(next)
  }

  // --- task placement (ST-F1-03: PLAN-06 drag / PLAN-07 right-click / auto) --

  // Place one task into a resolved grid slot; span = the task's estimated
  // duration, clamped to the end of the day. Optimistic (usePlaceTask).
  const placeTaskAt = (task, slot) => {
    // 이 화면에 남아 있던 마지막 "말 없이 사라지는" 경로 (리드 브라우저 재현,
    // 2026-08-28): 주간 계획이 아직 안 잡혔으면 드롭이 아무 흔적 없이 버려졌다
    // — 요청도 안 나가고 토스트도 없어서, 겉보기엔 아래 planLocked 분기나
    // 서버 실패와 구분이 되지 않는다. 오너의 "배치가 안 된다" 보고를 조사할 때
    // 바로 이 구분이 안 돼서 원인을 좁히는 데 시간이 걸렸다.
    if (!plan) {
      toast({ tone: 'info', message: '주간 계획을 불러오는 중입니다. 잠시 후 다시 시도해 주세요' })
      return
    }
    // fix G: a new placement is exactly the kind of plan change a draft under
    // review can't tolerate (same reasoning as planLocked's own header comment)
    // — the panel's task cards already stop offering drag/quick-place while
    // locked (UnplacedPanel's `disabled`, below), so this is normally
    // unreachable. It's still a real backstop though (e.g. a drag that began
    // just before `autoDraft` appeared), and until now this branch dropped the
    // drop with ZERO feedback — visually indistinguishable from "배치가 안
    // 되는 결함" (오너 보고, 2026-08-28): the block/ghost just snaps back with
    // no explanation. handleUserMove's own `isPastWeek` branch already sets
    // the precedent (a toast beats a silent no-op) — mirrored here for both
    // reasons `planLocked` can be true, since a dropped drag never reaches any
    // other error handling to explain itself.
    if (planLocked) {
      toast({
        tone: 'info',
        message: autoDraft
          ? '자동 배치 초안을 적용하거나 취소한 뒤 다시 배치해 주세요'
          : '지난 주에는 새로 배치할 수 없습니다',
      })
      return
    }
    // clampBlockSpan folds two invariant checks into one call: it snaps the
    // task's estimate to the 5-minute grid the server enforces (E-COM-009 —
    // an AI-suggested or partial-remainder estimate might not already be a
    // multiple of 5, see planTime.js's own header) AND keeps the placement
    // from crossing midnight, exactly like the hand-rolled clamp this
    // replaced did — see that helper's own comment for why both live in one
    // place now instead of six.
    const { startMin, endMin } = clampBlockSpan(slot.startMin, task.estimatedMinutes ?? 60)
    const dayISO = days[slot.dayIndex]
    placeTask({
      weeklyPlanId: plan.weeklyPlanId,
      weekStartISO,
      task,
      startAt: composeTimestamp(dayISO, startMin),
      endAt: composeTimestamp(dayISO, endMin),
    })
    // If an auto-place draft still proposes this task, drop it — applying the
    // draft later must not re-place a task the user just placed by hand.
    if (autoDraft) {
      setAutoDraft((d) =>
        d
          ? {
              ...d,
              placements: d.placements.filter((p) => p.taskId !== task.taskId),
              // 🔴 unplaced 는 이제 태스크 객체가 아니라 **UUID 문자열 배열**이다
              //    (계약 unplacedTaskIds). 예전처럼 `t.taskId` 로 비교하면 문자열엔
              //    그 속성이 없어 언제나 참이 되어 아무것도 안 걸러진다.
              unplaced: d.unplaced.filter((id) => id !== task.taskId),
            }
          : d,
      )
    }
    setSlotMenu(null)
  }

  // Panel→grid drag: the hook hit-tests the live pointer via resolveSlot (in its
  // pointer handlers, where reading the grid ref is allowed) and hands the drop
  // slot to onDrop; an off-grid release (null) is ignored.
  const placementDrag = usePlacementDrag({
    resolveSlot: (point) => {
      const el = gridBodyRef.current
      return el ? resolveGridSlot(point, el.getBoundingClientRect(), range) : null
    },
    onDrop: (task, slot) => {
      if (slot) placeTaskAt(task, slot)
    },
  })

  // Keyboard "quick place": drop the task in the first free slot of the week.
  //
  // Snapped HERE, before the search, not only in placeTaskAt's own clamp: the
  // slot search below only guarantees enough room for the durationMin it was
  // GIVEN. If that were the raw (possibly non-5-aligned) estimate and
  // placeTaskAt's clampBlockSpan then rounded it UP, the placed block could
  // overrun the very gap the search just confirmed was free — snapping once,
  // before the search, is what keeps "what we searched for" and "what we
  // place" the same number.
  const quickPlace = (task) => {
    const duration = snapDuration(task.estimatedMinutes ?? 60)
    const slot = findFirstFreeSlot({
      days,
      availability,
      blocks,
      durationMin: duration,
    })
    if (slot) placeTaskAt(task, slot)
    else toast({ tone: 'info', message: '이번 주에 배치할 빈 시간이 부족합니다' })
  }

  // Right-click an empty slot → open a small picker of unplaced tasks (PLAN-07).
  const handleEmptySlot = (point, slot) => {
    const tasks = unplacedQuery.data ?? []
    if (tasks.length === 0) {
      toast({ tone: 'info', message: '배치할 미배치 태스크가 없습니다' })
      return
    }
    setSlotMenu({ point, slot })
  }

  // Auto placement (RB-PLAN-01): announce progress, then hold the returned draft
  // as an overlay until the user applies or cancels it.
  //
  // No `priorityType` sent (owner/lead review, W2 API alignment): this
  // button has exactly ONE ordering, and its own toast text says which one —
  // "우선순위·마감일 순" is byPriorityThenDue, postAutoPlacements's own
  // no-argument default (see its header). This USED to hardcode
  // `priorityType: 'DEADLINE_FIRST'`, which was harmless only because the
  // mock silently ignored the argument; now that the mock branches on it for
  // real, sending that literal would have flipped this button to due-date
  // -first ordering while still claiming "우선순위·마감일 순" in the toast —
  // exactly the "조용히 바뀌는 정렬" this whole change was meant to prevent.
  const handleAutoPlace = () => {
    if (!plan) return
    toast({ tone: 'info', message: '우선순위·마감일 순으로 배치 중입니다…' })
    autoPlace.mutate(
      { weeklyPlanId: plan.weeklyPlanId },
      {
        // 🔴 초안 블록의 제목은 서버가 주지 않는다 — 계약(PlanBlockInput)이
        //    blockType·taskId·startAt·endAt 뿐이다. 격자는 `title` 로 그리므로
        //    (CalendarGrid 의 초안 렌더) 미배치 목록에서 taskId 로 이어 붙인다.
        //    못 찾으면 제목만 비고 배치 자체는 그대로 유효하다.
        onSuccess: (result) => setAutoDraft(withDraftTitles(result, unplacedQuery.data)),
      },
    )
  }

  const applyDraft = () => {
    if (!plan || !autoDraft) return
    applyAutoPlace.mutate(
      { weeklyPlanId: plan.weeklyPlanId, weekStartISO, placements: autoDraft.placements },
      {
        onSuccess: () => {
          setAutoDraft(null)
          toast({ tone: 'success', message: '초안을 적용했습니다. 확정하려면 저장하세요' })
        },
      },
    )
  }

  const cancelDraft = () => setAutoDraft(null)

  // Changing week invalidates a week-specific draft / open slot picker.
  const goToWeek = (delta) => {
    setWeekStartISO((w) => addWeeksISO(w, delta))
    setAutoDraft(null)
    setSlotMenu(null)
  }

  const goToThisWeek = () => {
    setWeekStartISO(currentWeekStartISO())
    setAutoDraft(null)
    setSlotMenu(null)
  }

  // --- block resize (ST-F1-04 A2 + A4) --------------------------------------

  // A block's edge-drag lands here as a target slot; commit new start/end times.
  // Shrinking a TASK block frees remainder time back to the unplaced panel (A4).
  const handleResizeCommit = (block, { dayIndex, startMin, endMin }) => {
    // fix G: resize is a plan change, same as a move — locked while a draft is
    // under review, on top of the pre-existing past-week lock.
    if (planLocked) return
    const dayISO = days[dayIndex]
    resizeBlock({
      weekStartISO,
      planBlockId: block.planBlockId,
      blockType: block.blockType,
      startAt: composeTimestamp(dayISO, startMin),
      endAt: composeTimestamp(dayISO, endMin),
    })
  }

  // A3: dropping a TASK block over the (open) unplaced panel unplaces it instead
  // of moving. Returns true when consumed so usePlanDrag skips the move commit.
  const handleBlockDropOutside = (planBlockId, point) => {
    if (!panelOpen || !plan) return false
    const el = unplacedPanelRef.current
    if (!el) return false
    const r = el.getBoundingClientRect()
    const inPanel =
      point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom
    if (!inPanel) return false
    const block = blocks.find((b) => b.planBlockId === planBlockId)
    if (!block || block.blockType !== 'TASK') return false // schedules delete, not unplace
    handleRemoveBlock(block, 'unplace')
    return true
  }

  // --- block action menu (ST-F1-04: PLAN-13/14 · 16 · 18) -------------------

  // A user-initiated removal (unplace/delete): commit it via the shared removal
  // path AND push an undo entry, mirroring handleUserMove's move+record pairing.
  // `history.claim` is threaded into removeBlock so its "실행 취소" toast and this
  // entry's ↶/↷ can never both invert the same removal (see usePlanData's doc).
  const handleRemoveBlock = (block, mode) => {
    const entry = removeBlock({
      weekStartISO,
      weeklyPlanId: plan?.weeklyPlanId,
      block,
      mode,
      claim: history.claim,
    })
    history.record(entry)
  }

  // Open the edit form for a schedule block, prefilled from its (denormalized) data.
  const openScheduleEdit = (block) => {
    const startMin = minutesOfDay(block.startAt)
    const endMin = minutesOfDay(block.endAt)
    setScheduleForm({
      mode: 'edit',
      block,
      initial: {
        title: block.title,
        dayISO: dateOf(block.startAt),
        startMin,
        endMin,
        estimatedMinutes: block.estimatedMinutes ?? endMin - startMin,
        priority: block.priority ?? 2,
        memo: block.memo ?? '',
      },
    })
  }

  // --- fixed schedule menu (ST-F1-06: PLAN-33/34) ---------------------------

  // Open the block menu for a FIXED schedule. `schedule` carries activeThisWeek,
  // so it's tagged blockType:'FIXED' and reused as the menu's `block` — the menu
  // only needs a title to show and a type to branch its item list on, exactly
  // like a TASK/SCHEDULE block already does.
  const openFixedMenu = (schedule, position) => {
    setMenu({ open: true, block: { ...schedule, blockType: 'FIXED' }, position })
  }

  // AC-3: after the exception toggle lands, force a dry-run against the SAME
  // block set — nothing about the local blocks changed, only the server's fixed-
  // schedule state, so `revalidate` (not the debounced loop, which keys off the
  // blocks signature) is what actually re-runs V2 for this week.
  const handleToggleFixedException = (schedule) => {
    toggleFixedException.mutate(
      { fixedScheduleId: schedule.fixedScheduleId, weekStartISO, activate: schedule.activeThisWeek === false },
      { onSuccess: () => validation.revalidate(blocks) },
    )
  }

  // PLAN-20 menu entry (plan-polish), shared by TASK/SCHEDULE — FIXED has no
  // "other week" concept at all (it recurs by weekday, never a specific date).
  // "다음 주로 이동" always applies (moving further into the future is never
  // blocked); "이전 주로 이동" is OMITTED entirely — not shown disabled — when
  // the previous week is already past, per handleUserMove's own guard above.
  // Omitting rather than disabling: BlockActionMenu's item shape has no
  // disabled/reason field today (unlike the Button atom's disabledReason), and
  // every other conditionally-unavailable item in menuItemsFor below (태스크
  // 편집/프로젝트에서 보기/배치 해제, all gated on `readOnly`) already follows
  // "just don't push it" — this keeps that one convention instead of adding a
  // second, disabled-item pattern to a menu component three block types share.
  const moveMenuItems = (block) => {
    const items = [
      {
        key: 'move-next',
        label: '다음 주로 이동',
        onSelect: () => moveBlockToAdjacentWeek(block, 'next'),
      },
    ]
    if (!isPastWeek(addWeeksISO(weekStartISO, -1))) {
      items.push({
        key: 'move-prev',
        label: '이전 주로 이동',
        onSelect: () => moveBlockToAdjacentWeek(block, 'prev'),
      })
    }
    return items
  }

  // Menu items per block type (AC-1). Delete/unplace are soft — a "실행 취소" toast
  // defers the server op (no confirm dialog). 프로젝트에서 보기 navigates to
  // SCR-PROJ-WS (ST-F1-08); 태스크 편집 opens TaskEditModal in place (ST-F1-09,
  // owner override — no route, see that component's own header comment).
  //
  // plan-polish (AC-5 fix, extended by fix G): the read-only-except-완료/기록
  // shape now has TWO triggers — a past week (AC-5) and an auto-place draft
  // under review (fix G) — both folded into `planLocked` (see its own header
  // comment above) rather than checking `readOnly` and `autoDraft` separately
  // in every branch below. FIXED's exception toggle and SCHEDULE's edit/delete
  // are both plan changes and stay blocked either way; TASK's complete/log are
  // exempted, only its OTHER items (편집/프로젝트에서 보기/배치 해제/다음·이전
  // 주로 이동) are blocked.
  const menuItemsFor = (block) => {
    if (!block) return []
    if (block.blockType === 'FIXED') {
      // A weekly exception is a plan change, and FIXED has no 완료/기록
      // equivalent — nothing is exempt here.
      if (planLocked) return []
      const active = block.activeThisWeek !== false
      return [
        {
          key: active ? 'deactivate' : 'reactivate',
          // AC-1's "주차 한정임을 문구로 명시" is carried by this LABEL itself —
          // "이번 주만" already states the scope in words, so no separate caption
          // is needed alongside it (a prior version added one; the owner found it
          // redundant on review, and removing it also removed the only consumer
          // of BlockActionMenu's `note` prop — see that file's history if a
          // future action needs a caption again).
          label: active ? '이번 주만 비활성화' : '다시 활성화',
          onSelect: () => handleToggleFixedException(block),
        },
      ]
    }
    if (block.blockType === 'SCHEDULE') {
      // A schedule block has no 완료/기록 concept either (that's TASK-only,
      // below) — edit/delete are both plan changes, so a locked week/draft
      // gets nothing.
      if (planLocked) return []
      return [
        { key: 'edit', label: '일정 편집', onSelect: () => openScheduleEdit(block) },
        ...moveMenuItems(block),
        {
          key: 'delete',
          label: '일정 삭제',
          tone: 'danger',
          onSelect: () => handleRemoveBlock(block, 'delete'),
        },
      ]
    }
    // TASK block. complete/log are the two AC-5 carve-outs — always present,
    // locked week/draft or not; everything past them changes the PLAN itself
    // (moves the task off/around the week), so those stay gated on `planLocked`.
    const done = block.status === 'COMPLETED'
    const items = [
      {
        key: 'complete',
        label: done ? '미완료로 되돌리기' : '완료로 표시',
        onSelect: () =>
          setBlockComplete({ weekStartISO, taskId: block.taskId, complete: !done }),
      },
      { key: 'log', label: '실제 시간 기록', onSelect: () => setExecLog({ block }) },
    ]
    if (planLocked) return items
    items.push({ key: 'edit', label: '태스크 편집', onSelect: () => setTaskEditTaskId(block.taskId) })
    if (block.projectId) {
      items.push({
        key: 'project',
        label: '프로젝트에서 보기',
        onSelect: () => navigate(`/projects/${block.projectId}`),
      })
    }
    items.push(...moveMenuItems(block))
    items.push({
      key: 'unplace',
      label: '배치 해제',
      onSelect: () => handleRemoveBlock(block, 'unplace'),
    })
    return items
  }

  // --- schedule create/edit + execution log (ST-F1-04 Phase 2) --------------

  // Right-clicked empty slot → open the create form seeded from that slot (PLAN-08).
  const openScheduleCreate = (slot) => {
    setSlotMenu(null)
    const startMin = slot.startMin
    setScheduleForm({
      mode: 'create',
      initial: {
        title: '',
        dayISO: days[slot.dayIndex],
        startMin,
        endMin: Math.min(startMin + 60, MINUTES_PER_DAY),
        estimatedMinutes: 60,
        priority: 2,
        memo: '',
      },
    })
  }

  const submitSchedule = (payload) => {
    if (!plan) return
    if (scheduleForm?.mode === 'create') {
      createSchedule.mutate(
        {
          weeklyPlanId: plan.weeklyPlanId,
          weekStartISO,
          body: { blockType: 'SCHEDULE', status: 'SCHEDULED', ...payload },
        },
        { onSuccess: () => setScheduleForm(null) },
      )
    } else if (scheduleForm?.block) {
      updateSchedule.mutate(
        { scheduleId: scheduleForm.block.scheduleId, weekStartISO, patch: payload },
        { onSuccess: () => setScheduleForm(null) },
      )
    }
  }

  const submitExecLog = ({ actualMinutes, result, memo }) => {
    if (!execLog) return
    const { block } = execLog
    const endedAt = new Date(
      new Date(block.startAt).getTime() + actualMinutes * 60000,
    ).toISOString()
    logExecution.mutate(
      { taskId: block.taskId, body: { startedAt: block.startAt, endedAt, actualMinutes, result, memo } },
      { onSuccess: () => setExecLog(null) },
    )
  }

  // --- save (PLAN-03 · PLAN-28: the validation-gated confirm) ----------------

  /*
    The gate has three outcomes, decided by the CURRENT dry-run result:
      차단 > 0   → the save button is disabled (PlanHeader owns that, with the
                   reason as adjacent text); this handler is unreachable.
      경고 only  → a confirm dialog, because the plan is savable but imperfect.
      깨끗함     → save immediately; asking would be a pointless click.
  */
  const handleSaveClick = () => {
    // `validation.stale` is not belt-and-braces: the button is disabled in the
    // same conditions, but this handler is also the one path a stray Enter or a
    // stale click can still reach, and confirming a plan nobody checked is the
    // exact failure this gate exists to prevent.
    //
    // `!savable` (W3 2차 리뷰) replaces the old `blockingCount > 0` check here —
    // see `savable`'s own comment above for why the server's verdict must win.
    if (!plan || !canWrite || !savable || validation.stale) return
    if (warningCount > 0) {
      setConfirmSaveOpen(true)
      return
    }
    commitSave()
  }

  /*
    PUT status:"CONFIRMED". Two things happen only on SUCCESS: the undo stack is
    cleared (PLAN-03 — a confirmed week is the new floor, nothing may be undone
    past it) and the week is refetched, since confirming can change server-side
    fields we don't model locally.
  */
  const commitSave = () => {
    if (!plan) return
    saveWeekPlan.mutate(
      {
        weeklyPlanId: plan.weeklyPlanId,
        weekStartISO,
        weekStartDate: plan.weekStartDate,
        weekEndDate: plan.weekEndDate,
        totalPlannedMinutes: plan.totalPlannedMinutes ?? 0,
      },
      {
        onSuccess: () => {
          setConfirmSaveOpen(false)
          history.clear()
        },
        onError: (error) => {
          setConfirmSaveOpen(false)
          handleSaveError(error)
        },
      },
    )
  }

  /*
    AC-4 — two DIFFERENT 409s can land here, confirmed against the real error
    catalog (ErrorCode.java/errors.properties, 대조 2026-08-03), and they must
    not share one explanation:
      E-PLAN-004 — NOT a race. The server re-ran validation on confirm and
        found blocking items still present (PLAN-28's own rule, enforced
        again server-side). This is the SAME "차단" state ReviewPanel/
        PlanHeader already model for the client-side dry-run.
      E-COM-006  — the actual optimistic-lock race: someone (another tab/
        device) confirmed a newer version of this week first, so what we
        validated is no longer what the server holds.
    (이전엔 이 둘을 구분하지 않고 아무 409나 "확정 레이스"로 취급해 하나의 문구를
    보여줬다 — E-PLAN-004는 검증 게이트 차단이지 레이스가 아니라서, 그 문구가
    사용자에게 엉뚱한 원인을 확신 있게 알려주는 셈이었다. 실서버 카탈로그
    대조로 발견·정정.)

    Both still get the SAME re-sync: the panel is re-synced from the error's own
    `details.issues` when it carries them, and from a forced dry-run when it
    doesn't; the week is refetched either way, so the grid, the counts and the
    save gate all end up describing the CURRENT server state rather than the one
    we submitted. Only the TOAST COPY differs by cause. A 409 whose code is
    neither of the two known ones still gets this same re-sync (a 409 on this
    endpoint always means "our picture of this week disagrees with the
    server's" one way or another) but earns the neutral generic toast instead of
    guessing which of the two specific explanations applies.

    The save button goes back to DISABLED immediately and without a dedicated
    conflict flag: both branches below make `validation.stale` true — adopted
    server issues are stamped as not-ours, and the forced dry-run is in flight —
    so the gate is shut the moment the 409 lands, not a round trip later. It
    reopens only once a fresh dry-run vouches for the refreshed plan.

    The dry-run is forced in BOTH branches on purpose: TanStack's structural
    sharing can hand back the identical blocks array after the refetch, which
    would leave the debounce loop with nothing to react to and the gate shut
    forever.

    Nor is OVL-CONFLICT shown here for E-COM-006 — that overlay is not mounted
    by any screen yet (errorRouting.js only catalogs the routing), so an
    in-panel refresh plus one toast is the whole surface, with no duplicate
    conflict UI to collide with.
  */
  const handleSaveError = (error) => {
    const isValidationBlocked = error?.code === 'E-PLAN-004'
    const isVersionConflict = error?.code === 'E-COM-006'
    const isConflictLike = isValidationBlocked || isVersionConflict || error?.status === 409
    if (isConflictLike) {
      const serverIssues = error?.details?.issues
      if (Array.isArray(serverIssues)) validation.applyServerIssues(serverIssues)
      validation.revalidate(blocks)
      planQuery.refetch()
      toast({
        tone: 'error',
        message: isValidationBlocked
          ? '차단 항목이 남아 있어 저장할 수 없습니다. 검토 항목을 확인해 주세요'
          : isVersionConflict
            ? '이 주간 계획이 다른 곳에서 먼저 저장되었습니다. 검토 항목을 다시 확인해 주세요'
            : systemMessages.error.writeTitle,
      })
      return
    }
    toast({ tone: 'error', message: systemMessages.error.writeTitle })
  }

  // --- replan alternatives (ST-F1-07: PLAN-29) ------------------------------

  // Strip `?openReplan=1` once it has done its job (opening the modal already
  // happened in replanOpen's lazy initializer above) — an Effect is the right
  // tool for exactly this part: it is talking to an external system (the
  // browser URL), not mirroring a prop into this component's own state.
  useEffect(() => {
    if (searchParams.get('openReplan') !== '1') return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('openReplan')
        return next
      },
      { replace: true },
    )
    // Runs once per mount: the param is gone from `searchParams` after the
    // first pass, so the guard above skips every render after that on its own
    // — no ref needed.
  }, [searchParams, setSearchParams])

  // Strip `?openUnplaced=1`/`?project={id}` the same way, once they've done
  // their job (already seeded into panelOpen/projectFilter's lazy initializers
  // above). One effect for both since they always arrive/leave together from
  // this page's point of view — no ordering dependency between the two deletes.
  useEffect(() => {
    const hasOpenUnplaced = searchParams.get('openUnplaced') === '1'
    const hasProject = searchParams.get('project') !== null
    if (!hasOpenUnplaced && !hasProject) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('openUnplaced')
        next.delete('project')
        return next
      },
      { replace: true },
    )
    // Same once-per-mount reasoning as the `openReplan` effect above: both
    // params are gone from `searchParams` after the first pass.
  }, [searchParams, setSearchParams])

  // Every open (re)requests all three generated alternatives against whatever
  // the CURRENT draft is — see useReplanOptions's header for why reusing a
  // stale batch would be wrong, not just wasteful.
  useEffect(() => {
    if (replanOpen) generateReplanOptions()
    // Only `replanOpen`'s OWN transition (or the plan actually changing under
    // it) should re-trigger generation — `generateReplanOptions` is stable per
    // weeklyPlanId (see useReplanOptions's useCallback deps), so listing it
    // here doesn't cause a re-run on every render.
  }, [replanOpen, generateReplanOptions])

  const closeReplan = () => {
    setReplanOpen(false)
    setApplyConflict(false)
    resetReplanOptions()
  }

  const handleApplyReplan = (option) => {
    if (!plan) return
    if (option.strategyType === BASELINE_STRATEGY_TYPE) {
      // 기존 계획 유지안: the server is already in this state — nothing to send.
      closeReplan()
      return
    }
    applyReplanOption.mutate(
      { replanOptionId: option.replanOptionId, weekStartISO },
      {
        onSuccess: () => {
          closeReplan()
          // Best-effort immediate re-check against the (still-stale-for-a-beat)
          // local `blocks`; the invalidate above's background refetch lands a
          // moment later and the debounce loop re-fires on its own once `blocks`
          // actually changes identity — same two-step reasoning handleSaveError
          // uses for its own post-conflict revalidate.
          validation.revalidate(blocks)
          toast({ tone: 'success', message: '재계획 대안을 적용했습니다. 확정하려면 저장하세요' })
        },
        // DIVERGENCE NOTE (flagged for the PR body): the 작업지시's AC-3 reads this
        // 409 as "계획 변경됨" (the plan moved on since these options were
        // generated) and asks for "다시 생성 유도" — followed here. The 07 CSV's
        // own documented 409 for THIS endpoint is narrower: "이미 선택된 재계획
        // 대안" (this option was already applied). Those are different failures —
        // if the 07 reading is the real server behavior, regenerating a fresh
        // batch does nothing to fix an "already applied" rejection of the SAME
        // option id, since a fresh batch gets fresh ids anyway (so it's harmless,
        // just a wasted round-trip in that specific case). Kept as the AC-3
        // wording pending a decision from the lead on which 409 meaning the real
        // server implements.
        onError: (error) => {
          if (error?.status === 409) {
            setApplyConflict(true)
            toast({
              tone: 'error',
              message: '이 대안이 더 이상 유효하지 않습니다. 대안을 다시 생성해 주세요',
            })
            return
          }
          toast({ tone: 'error', message: systemMessages.error.writeTitle })
        },
      },
    )
  }

  const handleGenerateAllReplan = () => {
    setApplyConflict(false)
    generateReplanOptions()
  }

  // --- render ---------------------------------------------------------------

  if (planQuery.isError) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorState variant="section" onAction={() => planQuery.refetch()} />
      </div>
    )
  }

  const showColumnSkeleton = planQuery.isLoading || (planQuery.isPlaceholderData && planQuery.isFetching)

  return (
    <div className="flex flex-col gap-4">
      <PlanHeader
        blockingCount={blockingCount}
        warningCount={warningCount}
        savable={savable}
        validationStale={validation.stale}
        validationDelayed={validation.delayed}
        onOpenReview={() => setReviewOpen(true)}
        onSave={handleSaveClick}
        saving={saveWeekPlan.isPending}
        canWrite={canWrite}
        offlineReason={systemMessages.offline.disabledReason}
        readOnly={readOnly}
      />

      <section className="relative flex flex-col gap-3 rounded-card border border-border bg-surface p-3 md:p-4">
        <WeekNav
          weekStartISO={weekStartISO}
          isCurrentWeek={weekStartISO === currentWeekStartISO()}
          onPrev={() => goToWeek(-1)}
          onNext={() => goToWeek(1)}
          onToday={goToThisWeek}
        />

        <SummaryBar
          usedMinutes={plan?.totalPlannedMinutes ?? 0}
          availableMinutes={availableMinutes}
          mode={mode}
          onModeChange={setMode}
        />

        <div ref={gridWrapperRef} className="relative">
          {showColumnSkeleton && (
            <div
              className="pointer-events-none absolute inset-0 z-40 animate-pulse rounded-card bg-surface/40"
              aria-hidden="true"
            />
          )}
          <CalendarGrid
            weekDays={days}
            range={range}
            mode={mode}
            blocks={blocks}
            availability={availability}
            // fix G: CalendarGrid's `readOnly` prop is really "can't edit right
            // now" — it already drives every plan-changing gate inside (drag,
            // resize, the availability handles, right-click-to-place, and the
            // AC-5 disabled/moveLocked split on PlanBlock/FixedScheduleBlock),
            // so passing `planLocked` here — instead of adding a second,
            // parallel `draftLocked` prop CalendarGrid would need to OR into
            // every one of those gates itself — extends all of them to the
            // draft-review case for free. PlanHeader below still gets the bare
            // `readOnly` (its "지난 주간 계획" banner would be WRONG to show
            // during a draft review on the CURRENT week).
            readOnly={planLocked}
            onMoveCommit={handleUserMove}
            onOpenMenu={(block, position) => setMenu({ open: true, block, position })}
            onAvailabilityCommit={handleAvailabilityCommit}
            bodyRef={gridBodyRef}
            placement={placementDrag.drag}
            draftBlocks={autoDraft?.placements ?? null}
            onEmptySlot={handleEmptySlot}
            onResizeCommit={handleResizeCommit}
            onBlockDropOutside={handleBlockDropOutside}
            violationsByBlockId={violationsByBlockId}
            focusRequest={focusRequest}
            fixedSchedules={fixedSchedulesQuery.data ?? []}
            onOpenFixedMenu={openFixedMenu}
            // No bodyMaxHeight override: the grid always uses CalendarGrid's own
            // constant default now (fix E removed the autoDraft-shrink hack this
            // prop used to carry — AutoPlaceBar is an overlay, so nothing about
            // it needs the grid to compensate anymore).
          />
        </div>

        {/* Auto-place draft banner (fix F). Styled and positioned like a toast
            (rounded-card + shadow-modal, floats above the card, bottom of
            screen) but deliberately NOT the Toaster queue below: that one
            auto-dismisses on a timer and gets pushed out by a later toast —
            this carries a live [적용]/[취소] decision that has to stay on
            screen until the user acts on it either way.

            This REPLACES fix E's first attempt (an overlay anchored to
            SummaryBar's own bottom): that kept the grid frozen but traded it
            for covering SummaryBar's stats AND its 포커스/24시간 토글 for as
            long as the draft was open — a real usability cost the owner
            flagged. This version covers NOTHING: it floats outside the
            section's flex-col flow entirely (same reasoning as the
            floating-controls block right below — `fixed` on mobile /
            `md:absolute` on desktop, anchored to this `relative` section), so
            it still can never resize or reposition the grid (fix E's actual
            fix), while not sitting over any existing content at rest either.

            Positioning, deliberately NOT bottom-center like Toaster:
            - Left-anchored (`left-4`/`md:left-6`, matching the floating
              controls' own left inset) and width-capped on desktop
              (`md:max-w-sm`, 384px) so it can never reach into the unplaced
              panel's column on the right. The panel spans nearly this whole
              card's height while open (its bottom edge is pinned to
              floatingControlsRef's bottom, its top to the grid's), so a
              bottom-CENTERED banner wide enough to read comfortably would
              overlap it on plenty of real desktop widths (checked: an
              ~448px-wide centered bar's right edge already passes the
              panel's left edge on a 1024px viewport, the narrow end of what
              counts as "desktop" here).
            - Stacked ABOVE the undo/redo/FAB row with real clearance
              (`bottom-36` mobile / `md:bottom-24` desktop vs. that row's own
              `bottom-18`/`md:bottom-6`), not beside or below it — sitting
              over any of those controls would make [적용]/[취소] itself
              unreachable the same way fix E's own bug did (a floating
              notification covering an actionable control), and `bottom-18`
              already clears the mobile BottomTabBar the same way the
              floating-controls comment above documents, so stacking further
              up than that keeps this banner clear of the tab bar too.

            fix I width math (the owner's exact two-sentence caption, each
            forced onto its OWN line via AutoPlaceBar's `md:whitespace-nowrap`
            — see that file): the longer sentence ("초안입니다. 적용해도 주간
            계획은 아직 저장되지 않습니다.") is ~24 full-width Korean glyphs +
            8 narrow marks (spaces/periods) — at text-caption (12px) this is
            roughly 350-360px, +24px for AutoPlaceBar's own `p-3` padding ≈
            374-384px needed. `md:max-w-sm` is EXACTLY 384px — this was
            already the safe ceiling before the panel at the narrow desktop
            floor (768px viewport: this banner's right edge at 24+384=408px
            vs. the panel's left edge at 768-8-344=416px, an 8px margin) —
            there is no room to widen the cap further without risking the
            panel, so the two are right at the edge of each other. This is a
            STATIC estimate, not a measured one — I could not verify the exact
            wrap point pixel-for-pixel without a live browser (dev server is
            on :5177 per the lead; worth an actual check at ~768px width
            specifically). Mobile is NOT held to the same nowrap guarantee —
            see AutoPlaceBar's own comment on why forcing it risks a page-wide
            horizontal-scroll bug instead of just an occasional 3rd line;
            the computed floor below which even a best-effort fit starts
            failing is roughly a 410-420px viewport (32px of `left-4 right-4`
            margin + 24px padding + the ~355-360px sentence), well above the
            ~360-412px many phones actually are, in portrait. */}
        {autoDraft && (
          <div
            role="status"
            className="pointer-events-none fixed bottom-36 left-4 right-4 z-30 md:absolute md:bottom-24 md:left-6 md:right-auto md:max-w-sm"
          >
            <div className="pointer-events-auto rounded-card shadow-modal">
              <AutoPlaceBar
                placedCount={autoDraft.placements.length}
                unplacedCount={autoDraft.unplaced.length}
                applying={applyAutoPlace.isPending}
                onApply={applyDraft}
                onCancel={cancelDraft}
              />
            </div>
          </div>
        )}

        {/* Floating controls: undo/redo bottom-left, unplaced FAB bottom-right.

            Mobile (fixed): pinned to the VIEWPORT bottom, like BottomTabBar,
            so they stay put on screen while the page/grid scrolls — an
            absolute, card-relative offset can't guarantee that: the card's
            own bottom edge moves with scroll and, on many phone-height
            viewports, ends up right behind the tab bar at rest (scrollTop 0)
            regardless of how much trailing padding `<main>` reserves below
            it — that padding only becomes reachable once scrolled into.
            bottom-18 (72px) clears BottomTabBar with a 16px gap: 72px =
            --spacing-bar (56px, the tab bar's own height) + 16px, measured
            from the viewport now instead of the card. Kept as the literal
            bottom-18 utility rather than a calc() off the token, like
            AppLayout's pb-24 and Toaster's bottom-24 (the other two spots
            that clear this same bar) — this exact, owner-approved 72px
            can't drift from an arithmetic slip. No ancestor between here and
            <body> sets transform/filter/contain/perspective, so `fixed`
            really is viewport-relative here, not card-relative (checked
            AppLayout, App, main.jsx).

            Desktop (md:absolute): reverts to the pre-existing card-pinned,
            grid-overlaying behavior (design) — there's no tab bar to clear,
            and the card is already centered (max-w-page mx-auto), so pinning
            to the viewport instead would visually detach the buttons from
            the grid they act on. */}
        <div
          ref={floatingControlsRef}
          className="pointer-events-none fixed inset-x-4 bottom-18 z-30 flex items-center justify-between md:absolute md:inset-x-6 md:bottom-6"
        >
          <div className="pointer-events-auto">
            {/* fix G: an undo/redo IS a block move, so it's gated the same as
                any other move while a draft is under review — undoing (or
                redoing) a prior move would change the block set the draft's
                placements were computed against, same as a fresh drag would. */}
            <UndoRedo
              canUndo={canUndo && !planLocked}
              canRedo={canRedo && !planLocked}
              onUndo={handleUndo}
              onRedo={handleRedo}
            />
          </div>
          {/* FAB hides while the panel is open; reappears on close. */}
          <div className="pointer-events-auto">
            {!panelOpen && (
              <PlanFab count={unplacedCount} onClick={() => setPanelOpen(true)} />
            )}
          </div>
        </div>
      </section>

      <BlockActionMenu
        open={menu.open}
        block={menu.block}
        position={menu.position}
        items={menuItemsFor(menu.block)}
        onClose={() => setMenu({ open: false, block: null, position: null })}
      />

      {/* Schedule create/edit (PLAN-08/17) — keyed so it mounts fresh per open. */}
      {scheduleForm && (
        <ScheduleForm
          key={scheduleForm.mode + (scheduleForm.block?.planBlockId ?? 'new')}
          mode={scheduleForm.mode}
          initial={scheduleForm.initial}
          onClose={() => setScheduleForm(null)}
          onSubmit={submitSchedule}
          submitting={createSchedule.isPending || updateSchedule.isPending}
        />
      )}

      {/* Actual-time log (PLAN-15). */}
      {execLog && (
        <ExecutionLogForm
          key={execLog.block.planBlockId}
          block={execLog.block}
          onClose={() => setExecLog(null)}
          onSubmit={submitExecLog}
          submitting={logExecution.isPending}
        />
      )}

      {/* 태스크 편집 (ST-F1-09, owner override — modal, not a route). See
          TaskEditModal.jsx's own header for why a graceful in-modal
          not-found is expected here, not a bug. */}
      {taskEditTaskId && (
        <TaskEditModal taskId={taskEditTaskId} onClose={() => setTaskEditTaskId(null)} />
      )}

      <ReviewPanel
        open={reviewOpen}
        blockingCount={blockingCount}
        warningCount={warningCount}
        issues={validation.issues}
        delayed={validation.delayed}
        onSelectIssue={handleSelectIssue}
        onClose={() => setReviewOpen(false)}
        // Closes the review panel first (both shells are focus-trapped modals;
        // see handleSelectIssue's comment on why one always closes before the
        // other opens) then opens the replan modal on the very next tick.
        onOpenReplan={() => {
          setReviewOpen(false)
          setReplanOpen(true)
        }}
      />

      {/* 재계획 대안 (ST-F1-07 PLAN-29) — mounted CONDITIONALLY (fresh per open,
          same pattern as ScheduleForm/ExecutionLogForm above) so useReplanOptions
          starts a clean generation batch every time this opens. */}
      {replanOpen && (
        <ReplanOptionsModal
          strategies={replanStrategies}
          onGenerateAll={handleGenerateAllReplan}
          onRetryStrategy={retryReplanOption}
          onApply={handleApplyReplan}
          onClose={closeReplan}
          applying={applyReplanOption.isPending}
          applyConflict={applyConflict}
          isGenerating={replanGenerating}
          slowNotice={replanSlowNotice}
        />
      )}

      {/* Warnings-only save confirmation (PLAN-28). 차단 never gets here — the
          save button is disabled while any remains. */}
      <SaveConfirmDialog
        open={confirmSaveOpen}
        warningCount={warningCount}
        warnings={warningIssues}
        saving={saveWeekPlan.isPending}
        onConfirm={commitSave}
        onCancel={() => setConfirmSaveOpen(false)}
      />

      <UnplacedPanel
        open={panelOpen}
        panelRef={unplacedPanelRef}
        onClose={() => setPanelOpen(false)}
        topBound={panelBounds?.top}
        heightBound={panelBounds?.height}
        count={unplacedCount}
        tasks={unplacedQuery.data ?? []}
        isLoading={unplacedQuery.isLoading}
        isError={unplacedQuery.isError}
        onRetry={() => unplacedQuery.refetch()}
        projectId={projectFilter}
        onProjectFilterChange={setProjectFilter}
        onAutoPlace={handleAutoPlace}
        autoPlacing={autoPlace.isPending}
        // fix G: `disabled` now also covers "a draft is under review" (not
        // just past-week), which additionally disables re-triggering [자동
        // 배치] while one is already open — a deliberate side effect, not a
        // separate fix, since re-running it mid-review would silently replace
        // the very draft the user is looking at. `disabledReason` used to be a
        // literal "지난 주는 편집할 수 없습니다" baked into UnplacedPanel — that
        // wording would be WRONG for the draft-review reason, so it's now
        // computed here (the one place that knows WHICH of the two applies)
        // and passed through instead.
        disabled={planLocked}
        disabledReason={
          readOnly
            ? '지난 주는 편집할 수 없습니다'
            : autoDraft
              ? '초안을 적용하거나 취소한 후 이용할 수 있습니다'
              : undefined
        }
        onTaskPointerDown={placementDrag.begin}
        onQuickPlace={quickPlace}
      />

      {/* Empty-slot task picker (PLAN-07). Desktop right-click only; a backdrop
          closes it on outside click. */}
      {slotMenu &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onPointerDown={() => setSlotMenu(null)} aria-hidden="true" />
            <div
              role="menu"
              aria-label="여기에 배치할 태스크 선택"
              // Same cursor-flip anchoring as BlockActionMenu — a fixed clamp
              // assumed a max popover size and clipped once the task list grew.
              style={getPopoverAnchorStyle(slotMenu.point)}
              className="fixed z-50 max-h-64 w-60 overflow-y-auto rounded-card border border-border bg-surface py-1 shadow-popover"
            >
              <p className="px-3 py-2 text-caption font-medium text-text-muted">여기에 배치</p>
              <div className="h-px bg-border" />
              <button
                type="button"
                onClick={() => openScheduleCreate(slotMenu.slot)}
                className="flex w-full items-center px-3 py-2 text-left text-label font-medium text-brand-700 transition-colors hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"
              >
                + 새 일정 만들기
              </button>
              <div className="h-px bg-border" />
              <ul>
                {(unplacedQuery.data ?? []).map((task) => (
                  <li key={task.taskId}>
                    <button
                      type="button"
                      onClick={() => placeTaskAt(task, slotMenu.slot)}
                      className="flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"
                    >
                      <span className="text-label font-medium text-text line-clamp-1">{task.title}</span>
                      <span className="text-caption text-text-muted">
                        예상 {Math.round((task.estimatedMinutes ?? 60))}분
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>,
          document.body,
        )}

      {/* Floating ghost following the cursor while dragging a task from the panel. */}
      {placementDrag.drag &&
        createPortal(
          <div
            aria-hidden="true"
            style={{ left: placementDrag.drag.point.x + 12, top: placementDrag.drag.point.y + 12 }}
            className="pointer-events-none fixed z-[60] max-w-48 rounded-control border border-brand-400 bg-brand-50 px-2.5 py-1.5 text-caption font-medium text-brand-900 shadow-popover"
          >
            <span className="line-clamp-1">{placementDrag.drag.task.title}</span>
          </div>,
          document.body,
        )}
    </div>
  )
}

export default WeeklyPage
