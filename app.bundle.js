/* ===== planEngine.js ===== */
/**
 * planEngine.js
 * ------------------------------------------------------------
 * Pure parsing logic — no DOM, no LocalStorage. This is the one
 * place that turns pasted ChatGPT text into structured data for
 * learning tracks (Python, English, and any user-added track) and
 * Workout plans.
 *
 * Every category is parsed with the same underlying routine,
 * groupBySections(): scan lines top to bottom, and whenever a
 * line matches that category's "header" pattern (a "Week N" line
 * for learning tracks, a weekday name for Workout), start a new
 * section and bucket every following line under it until the
 * next header.
 * ------------------------------------------------------------
 */

const PlanEngine = (() => {

  const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  // Requires the week number to be followed immediately by end-of-line,
  // a colon, or a dash — matches "Week 1", "Week 1:", "WEEK 01: Title".
  // Deliberately does NOT match "WEEK 01 GOAL" (a trailing recap line
  // some plans include after their last day) — without this, that line
  // gets mistaken for a second "Week 1" header and blows up parsing.
  const WEEK_HEADER_RE = /^week\s+(\d+)\s*(?::|-|—|–|$)/i;
  const DAY_HEADER_RE = new RegExp(`^(${DAY_NAMES.join('|')})\\b`, 'i');

  // Matches a "DAY NNN" sub-header inside a Week section, e.g.
  // "DAY 001 — Variables, Data Types & Input/Output" or "Day 3: Loops".
  // Unrelated to DAY_HEADER_RE above (that's Workout's weekday matcher).
  const TOPIC_DAY_HEADER_RE = /^day\s+\d+\b/i;

  function splitLines(text) {
    return (text || '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  /**
   * Shared grouping routine. `isHeader(line)` decides whether a
   * line starts a new section; `headerKey(line)` derives that
   * section's key from the header line itself. Lines before the
   * first recognized header are dropped — a plan is expected to
   * open with one. Each section also stores the raw header line
   * itself (`header`), so callers that need more than just a key
   * (e.g. an inline title on the header line) can extract it.
   */
  function groupBySections(lines, isHeader, headerKey) {
    const sections = [];
    let current = null;

    lines.forEach(line => {
      if (isHeader(line)) {
        current = { key: headerKey(line), header: line, items: [] };
        sections.push(current);
      } else if (current) {
        current.items.push(line);
      }
    });

    return sections;
  }

  /**
   * Extracts a day block's title from its header line, e.g.
   * "DAY 001 — Variables, Data Types & Input/Output" -> "Variables,
   * Data Types & Input/Output". Supports an em dash, en dash,
   * hyphen, or colon as the separator; falls back to whatever
   * follows the day number if none of those are present.
   */
  function extractDayTitle(line) {
    const match = line.match(/^day\s+\d+\s*[—\-–:]\s*(.+)$/i);
    if (match) return match[1].trim();
    const stripped = line.replace(/^day\s+\d+\s*/i, '').trim();
    return stripped || line.trim();
  }

  /**
   * Turns one Week section's raw lines into topics. Two formats are
   * supported, auto-detected:
   *
   *   1. Day-block format — "DAY NNN — Title" sub-headers, each
   *      followed by free-form detail (Targets/Outcome/bullets/
   *      whatever). Each DAY becomes exactly ONE topic (its title);
   *      everything under it is kept as supplementary `detail`
   *      rather than being split into separate topics.
   *
   *   2. Flat format (no DAY headers found) — one topic per line,
   *      with a single line containing 2+ spaces still splitting
   *      into multiple topics.
   */
  function parseWeekTopics(items) {
    const hasDayBlocks = items.some(line => TOPIC_DAY_HEADER_RE.test(line));

    if (hasDayBlocks) {
      const topics = [];
      let current = null;

      items.forEach(line => {
        if (TOPIC_DAY_HEADER_RE.test(line)) {
          current = { topic: extractDayTitle(line), detail: [] };
          topics.push(current);
        } else if (current) {
          current.detail.push(line);
        }
      });

      return topics.map(t => ({ topic: t.topic, detail: t.detail.join(' ') }));
    }

    return items
      .flatMap(item => item.split(/\s{2,}/).map(t => t.trim()).filter(Boolean))
      .map(topic => ({ topic, detail: '' }));
  }

  /**
   * Learning-track plans (Python, English, or any user-added
   * track): "Week N" headers, each containing either a flat list
   * of one-topic-per-line entries or a set of "DAY NNN — Title"
   * blocks (see parseWeekTopics above) — both parse to the same
   * flat topic list either way.
   */
  function parseTopicPlan(rawText) {
    const lines = splitLines(rawText);
    const sections = groupBySections(
      lines,
      line => WEEK_HEADER_RE.test(line),
      line => Number(line.match(WEEK_HEADER_RE)[1])
    );

    const weeks = sections.map(section => ({
      week: section.key,
      topics: parseWeekTopics(section.items)
    }));

    const flatTopics = [];
    weeks.forEach(w => w.topics.forEach(t =>
      flatTopics.push({ week: w.week, topic: t.topic, detail: t.detail || '' })
    ));

    return { weeks, flatTopics };
  }

  /**
   * Strips a markdown heading marker (#, ##, ###...) and any
   * leading non-letter characters (emoji, symbols) from a line, so
   * a header like "## 🔥 Monday – Upper Body Strength" can still be
   * recognized as starting with a weekday name underneath all that
   * formatting. Only applied to lines that are actual markdown
   * headings — see isWorkoutDayHeader for why that gate matters.
   */
  function stripHeadingNoise(line) {
    return line.replace(/^#+\s*/, '').replace(/^[^\p{L}]+/u, '').trim();
  }

  /**
   * A day header is either a markdown heading containing a weekday
   * name (cleaned of emoji/symbols first), or — for the simpler flat
   * format — a bare weekday name with nothing before it. Deliberately
   * does NOT clean non-heading lines before testing: a plan's notes
   * section can easily contain a bullet like "* Tuesday" or "*
   * Thursday only" (recovery-timing notes, not a new day block), and
   * stripping its leading "* " would wrongly match that too. Gating
   * the cleanup on an actual "#" heading marker avoids that.
   */
  function isWorkoutDayHeader(line) {
    if (/^#+\s*/.test(line)) {
      return DAY_HEADER_RE.test(stripHeadingNoise(line));
    }
    return DAY_HEADER_RE.test(line);
  }

  function workoutDayKey(line) {
    const cleaned = /^#+\s*/.test(line) ? stripHeadingNoise(line) : line;
    const match = cleaned.match(DAY_HEADER_RE);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Pulls a session title straight off the header line itself, e.g.
   * "🦵 Tuesday – Lower Body Strength + Neck" -> "Lower Body Strength
   * + Neck". Returns null if the header is just the bare day name
   * with nothing after it (e.g. plain "Monday") — the caller falls
   * back to the day's content lines in that case.
   */
  function extractInlineWorkoutLabel(headerLine) {
    const cleaned = /^#+\s*/.test(headerLine) ? stripHeadingNoise(headerLine) : headerLine;
    const match = cleaned.match(DAY_HEADER_RE);
    if (!match) return null;

    const afterDay = cleaned.slice(match[0].length).trim();
    const sepMatch = afterDay.match(/^[—\-–:]\s*(.+)$/);
    if (sepMatch) return sepMatch[1].trim();
    return afterDay || null;
  }

  /**
   * Groups a day's raw content lines under their "### Group" sub-
   * headers (e.g. Chest / Back / Shoulders), stripping bullet
   * markers off each exercise line. A stray line with no sub-header
   * above it is kept as its own ungrouped entry rather than dropped.
   */
  function parseWorkoutDayDetail(items) {
    const groups = [];
    let current = null;

    items.forEach(line => {
      if (/^#{2,6}\s+/.test(line)) {
        current = { group: line.replace(/^#{2,6}\s+/, '').trim(), exercises: [] };
        groups.push(current);
      } else {
        const cleanedLine = line.replace(/^[*•\-]\s*/, '').trim();
        if (!cleanedLine) return;
        if (current) {
          current.exercises.push(cleanedLine);
        } else {
          groups.push({ group: null, exercises: [cleanedLine] });
        }
      }
    });

    return groups;
  }

  /**
   * Workout plans: a weekday-name header per day, in either of two
   * shapes:
   *
   *   1. Rich format — the session title sits right on the header
   *      line ("## 🔥 Monday – Upper Body Strength"), possibly
   *      followed by markdown sub-headers (### Chest) and exercise
   *      bullets. The header's title becomes the day's label; the
   *      sub-headers/bullets underneath are kept as structured
   *      `detail` (an array of { group, exercises }) for a
   *      tap-to-expand view.
   *
   *   2. Flat format — a bare day name ("Monday") with the label on
   *      its own line(s) underneath. No structured detail in this
   *      case.
   *
   *   A day with no recognized label defaults to { label: 'Rest',
   *   detail: [] }.
   */
  function parseWorkoutPlan(rawText) {
    const lines = splitLines(rawText);
    const sections = groupBySections(lines, isWorkoutDayHeader, workoutDayKey);

    const days = {};
    DAY_NAMES.forEach(d => { days[d] = { label: 'Rest', detail: [] }; });

    sections.forEach(section => {
      const inlineLabel = extractInlineWorkoutLabel(section.header);
      const label = inlineLabel || section.items.join(' ').trim();
      if (!label) return;
      days[section.key] = {
        label,
        detail: inlineLabel ? parseWorkoutDayDetail(section.items) : []
      };
    });

    return { days };
  }

  function isRestLabel(label) {
    return !label || /rest/i.test(label);
  }

  /** Weekday name ('monday'..'sunday') for a JS Date, independent of locale. */
  function dayNameFor(date) {
    return DAY_NAMES[(date.getDay() + 6) % 7];
  }

  /**
   * Builds a full page controller ({init, render}) for a
   * topic-based plan page (any learning track — Python, English, or
   * a user-added one). All tracks are structurally identical —
   * "Week N" curriculum, a cursor, Current Topic / Today's Mission /
   * Completed / Remaining / Progress % — so this one factory drives
   * every track's page instead of each having its own copy of this
   * logic. This is what lets a newly-added track work immediately
   * with zero new code.
   *
   * `ids` maps every DOM element the page needs by id.
   */
  function createTopicPlanController(category, ids) {

    function renderSaveStatus(plan) {
      const el = document.getElementById(ids.statusId);
      if (!el) return;
      el.textContent = plan
        ? `Saved — ${plan.flatTopics.length} topic${plan.flatTopics.length === 1 ? '' : 's'} across ${plan.weeks.length} week${plan.weeks.length === 1 ? '' : 's'}`
        : '';
    }

    function handleSave() {
      const textarea = document.getElementById(ids.textareaId);
      const raw = textarea.value.trim();
      if (!raw) {
        UI.toast('Paste a plan before saving.');
        return;
      }
      const plan = Storage.savePlan(category, raw);
      UI.toast(plan.flatTopics.length === 0
        ? 'No topics found — check the "Week N" format.'
        : `${UI.TASK_META[category].label} plan saved`);
      render();
    }

    function renderMission() {
      const plan = Storage.getPlan(category);
      renderSaveStatus(plan);

      const weekHint = document.getElementById(ids.weekHintId);
      const currentTopicEl = document.getElementById(ids.currentTopicId);
      const missionTextEl = document.getElementById(ids.missionTextId);
      const actionsEl = document.getElementById(ids.missionActionsId);

      if (!plan) {
        if (weekHint) weekHint.textContent = '—';
        currentTopicEl.textContent = 'Upload a plan to get started.';
        missionTextEl.textContent = '—';
        actionsEl.innerHTML = '';
        return;
      }

      const progress = Storage.getTopicPlanProgress(category);
      const mission = Storage.getMission(category);

      if (weekHint) weekHint.textContent = progress.currentTopic ? `Week ${progress.currentTopic.week}` : 'Complete';
      currentTopicEl.textContent = progress.currentTopic
        ? progress.currentTopic.topic
        : 'Plan complete — every topic is done.';

      if (!mission || mission.isComplete) {
        missionTextEl.textContent = 'No mission left — upload a new plan to keep going.';
        actionsEl.innerHTML = '';
        return;
      }

      const task = Storage.getTask(category);
      missionTextEl.textContent = `${mission.topic} — Week ${mission.week}`;
      actionsEl.innerHTML = UI.renderActionButtonsHTML(category, task.status);
      UI.bindActionButtons(actionsEl, toStatus => {
        Storage.setTaskStatus(category, toStatus);
        UI.toast(`${UI.TASK_META[category].label} → ${UI.STATUS_LABEL[toStatus]}`);
        if (typeof Dashboard !== 'undefined') Dashboard.maybeUpdateStreak();
        render();
      });
    }

    function renderProgress() {
      const progress = Storage.getTopicPlanProgress(category);
      const pctEl = document.getElementById(ids.progressPctId);
      const fillEl = document.getElementById(ids.progressFillId);
      const completedCountEl = document.getElementById(ids.completedCountId);
      const remainingCountEl = document.getElementById(ids.remainingCountId);
      const completedListEl = document.getElementById(ids.completedListId);
      const remainingListEl = document.getElementById(ids.remainingListId);

      if (!progress) {
        pctEl.textContent = '0%';
        fillEl.style.width = '0%';
        completedCountEl.textContent = '0';
        remainingCountEl.textContent = '0';
        completedListEl.innerHTML = '<li class="topic-list__empty">Nothing completed yet.</li>';
        remainingListEl.innerHTML = '<li class="topic-list__empty">Upload a plan to see topics.</li>';
        return;
      }

      pctEl.textContent = `${progress.pct}%`;
      fillEl.style.width = `${progress.pct}%`;
      completedCountEl.textContent = String(progress.completed);
      remainingCountEl.textContent = String(progress.remaining);

      completedListEl.innerHTML = progress.completedTopics.length
        ? progress.completedTopics.map(t => `<li class="topic-list__item is-done">${t.topic}<span class="topic-list__week">Week ${t.week}</span></li>`).join('')
        : '<li class="topic-list__empty">Nothing completed yet.</li>';

      remainingListEl.innerHTML = progress.remainingTopics.length
        ? progress.remainingTopics.map(t => `<li class="topic-list__item">${t.topic}<span class="topic-list__week">Week ${t.week}</span></li>`).join('')
        : '<li class="topic-list__empty">All topics completed 🎉</li>';
    }

    function render() {
      Storage.generateMissionsFor(Storage.todayKey());
      renderMission();
      renderProgress();
    }

    function init() {
      const saveBtn = document.getElementById(ids.saveBtnId);
      if (saveBtn) saveBtn.addEventListener('click', handleSave);

      const plan = Storage.getPlan(category);
      const textarea = document.getElementById(ids.textareaId);
      if (plan && textarea) textarea.value = plan.raw;

      render();
    }

    return { init, render };
  }

  return {
    DAY_NAMES,
    parseTopicPlan,
    parseWorkoutPlan,
    isRestLabel,
    dayNameFor,
    createTopicPlanController
  };
})();

/* ===== recoveryEngine.js ===== */
/**
 * recoveryEngine.js
 * ------------------------------------------------------------
 * The core feature of the app. Pure logic — no DOM, no
 * LocalStorage — so this file is exactly what would need to
 * move to a Django backend later, unchanged, if the app grows
 * beyond a single browser tab.
 *
 * Recovery Algorithm (matches the original 6-step spec):
 *   1. Identify unfinished tasks       -> caller passes `candidates`
 *   2. Sort by recovery priority       -> caller passes `priorityOrder`
 *   3. Calculate available time        -> computeAvailableTime()
 *   4. Assign task modes (Minimum first) -> buildRecoveryPlan()
 *   5. Generate evening schedule       -> buildRecoveryPlan() (clock times)
 *   6. Defer lower-priority tasks      -> buildRecoveryPlan() (deferred[])
 *
 * IMPORTANT (architecture note): this module used to hardcode a
 * fixed RECOVERY_PRIORITY = ['python','english','startup','workout']
 * array, which baked "exactly these 4 categories" into the engine
 * itself. Since the app now supports an arbitrary number of
 * user-added learning tracks, priority order and category lists are
 * no longer constants here — the caller (storage.js, which knows
 * the current track registry) computes and passes them in on every
 * call. This file stays purely a function of its inputs.
 * ------------------------------------------------------------
 */

const RecoveryEngine = (() => {

  const MODE_RANK = { minimum: 0, standard: 1, extended: 2 };

  // A recovered workout session is intentionally shorter than the
  // ~80-minute morning block — this only runs when the user
  // explicitly opts in via "Recover Workout", never automatically.
  const WORKOUT_RECOVERY_MINUTES = { minimum: 20, standard: 30, extended: 45 };

  // Default mode minutes for a newly-added learning track that
  // hasn't been given its own preset — Startup's original tuning
  // (a middle-ground pace) is a reasonable universal default.
  const DEFAULT_TRACK_MINUTES = { minimum: 15, standard: 30, extended: 45 };

  const DEFAULTS = {
    dinnerMinutes: 30,
    windDownMinutes: 15,
    targetSleepMinutes: 22 * 60 + 30, // 10:30 PM
    eveningRecoveryLimitMinutes: 90,
    // A small cushion reserved at the end of the recovery window so
    // the schedule doesn't run right up against Wind Down.
    transitionBufferMinutes: 10
  };

  /** Minutes for a given category + mode. Learning tracks reuse the
   *  same Smart Task Mode table the Daily Planner uses
   *  (UI.TASK_MODE_MINUTES) — one set of numbers, not a second copy. */
  function minutesForMode(category, mode) {
    if (category === 'workout') {
      return WORKOUT_RECOVERY_MINUTES[mode] ?? WORKOUT_RECOVERY_MINUTES.minimum;
    }
    const table = (typeof UI !== 'undefined' && UI.TASK_MODE_MINUTES[category]) || DEFAULT_TRACK_MINUTES;
    return table[mode] ?? table.standard ?? 0;
  }

  /**
   * Step 3 — the evening math:
   *   Dinner runs immediately after work ends (default 30 min).
   *   Recovery starts right after dinner.
   *   Recovery ends at Target Sleep minus Wind Down (default 15 min).
   * All times are minutes-since-midnight, 24h.
   */
  function computeAvailableTime(workEndMinutes, overrides = {}) {
    const dinnerMinutes = overrides.dinnerMinutes ?? DEFAULTS.dinnerMinutes;
    const windDownMinutes = overrides.windDownMinutes ?? DEFAULTS.windDownMinutes;
    const targetSleepMinutes = overrides.targetSleepMinutes ?? DEFAULTS.targetSleepMinutes;

    const dinnerStart = workEndMinutes;
    const dinnerEnd = dinnerStart + dinnerMinutes;
    const recoveryStart = dinnerEnd;
    const recoveryEnd = targetSleepMinutes - windDownMinutes;
    const availableMinutes = Math.max(0, recoveryEnd - recoveryStart);

    return { dinnerStart, dinnerEnd, recoveryStart, recoveryEnd, availableMinutes };
  }

  /**
   * Steps 1-6. `candidates` must already be filtered by the caller
   * to only unfinished, non-skipped categories (and should only
   * include 'workout' if the user explicitly opted into recovering
   * it). `priorityOrder` is a full ordered list of every possible
   * category (all current learning tracks, then 'workout' last) —
   * computed by the caller from the live track registry, not a
   * fixed constant.
   *
   * Energy level controls the *optional upgrade pass* that runs
   * after every candidate has a Minimum-mode slot:
   *   - low:    no upgrades — everything stays at Minimum.
   *   - medium: only the single top-priority scheduled item may
   *             upgrade to Standard, if time allows.
   *   - high:   every scheduled item may upgrade toward Standard
   *             then Extended, in priority order, while time remains.
   * The hard 90-minute cap is enforced by whatever `availableMinutes`
   * the caller passes in.
   */
  function buildRecoveryPlan({ candidates, priorityOrder, availableMinutes, recoveryStartMinutes, energyLevel = 'medium' }) {
    const order = priorityOrder && priorityOrder.length ? priorityOrder : candidates;
    const ordered = order.filter(c => candidates.includes(c));

    let remaining = Math.max(0, availableMinutes);
    const scheduled = [];
    const deferred = [];

    // Step 4 (first pass) — Minimum mode, priority order, while it fits.
    ordered.forEach(category => {
      const minMinutes = minutesForMode(category, 'minimum');
      if (minMinutes <= remaining) {
        scheduled.push({ category, mode: 'minimum', minutes: minMinutes });
        remaining -= minMinutes;
      } else {
        deferred.push(category); // Step 6
      }
    });

    // Optional upgrade pass, gated by energy level.
    if (energyLevel === 'high') {
      ['standard', 'extended'].forEach(tier => {
        scheduled.forEach(item => {
          if (MODE_RANK[tier] <= MODE_RANK[item.mode]) return;
          const tierMinutes = minutesForMode(item.category, tier);
          const delta = tierMinutes - item.minutes;
          if (delta > 0 && delta <= remaining) {
            item.mode = tier;
            item.minutes = tierMinutes;
            remaining -= delta;
          }
        });
      });
    } else if (energyLevel === 'medium' && scheduled.length > 0) {
      const top = scheduled[0];
      const stdMinutes = minutesForMode(top.category, 'standard');
      const delta = stdMinutes - top.minutes;
      if (top.mode === 'minimum' && delta > 0 && delta <= remaining) {
        top.mode = 'standard';
        top.minutes = stdMinutes;
        remaining -= delta;
      }
    }
    // low energy: no upgrade pass at all.

    // Step 5 — stamp clock times onto the final schedule.
    let cursor = recoveryStartMinutes;
    scheduled.forEach(item => {
      item.startMinutes = cursor;
      item.endMinutes = cursor + item.minutes;
      cursor = item.endMinutes;
    });

    return {
      scheduled,
      deferred,
      usedMinutes: Math.max(0, availableMinutes) - remaining,
      remainingMinutes: remaining
    };
  }

  /**
   * Reality Score — deliberately simple and deterministic: it's a
   * function of what PERCENTAGE of the day's tasks ended completed,
   * not a fixed count. This generalizes correctly regardless of how
   * many total categories exist (originally a fixed 4; now
   * Workout + however many learning tracks are active). The floor is
   * 40, never lower — "the goal is progress, not perfection."
   *
   * `categories` is the full list of category keys to score against
   * (e.g. ['workout', 'python', 'english', 'startup', ...]) — passed
   * in by the caller since this module doesn't know the registry.
   */
  function computeRealityScore(dayTasks, categories) {
    const total = categories.length || 1;
    const completedCount = categories.filter(c => dayTasks[c] && dayTasks[c].status === 'completed').length;
    const pct = completedCount / total;

    if (pct >= 1) return { score: 100, label: 'Fully Completed' };
    if (pct >= 0.75) return { score: 80, label: 'Recovery Completed' };
    if (pct >= 0.5) return { score: 60, label: 'Partial Recovery' };
    return { score: 40, label: 'Minimal Progress' };
  }

  return {
    WORKOUT_RECOVERY_MINUTES,
    DEFAULT_TRACK_MINUTES,
    DEFAULTS,
    minutesForMode,
    computeAvailableTime,
    buildRecoveryPlan,
    computeRealityScore
  };
})();

/* ===== storage.js ===== */
/**
 * storage.js
 * ------------------------------------------------------------
 * Single access point for all LocalStorage reads/writes.
 *
 * ARCHITECTURE NOTE — Track Registry (schema v2):
 * Earlier versions of this app hardcoded exactly 4 task categories
 * (workout/python/english/startup) as constants sprinkled across
 * this file, ui.js, and recoveryEngine.js. That meant "add a new
 * learning track" was a code change, not a user-facing action. This
 * version replaces that with a real registry: `state.tracks` holds
 * every learning track (python/english/startup ship pre-seeded, and
 * behave exactly as before), and everywhere that used to say
 * "python, english, startup" now asks the registry instead. Workout
 * stays a fixed, special-cased category — its data model (a weekday
 * template) is fundamentally different from a sequential topic
 * track, not just a different name.
 *
 * Layering, unchanged in spirit from earlier phases:
 *   Tasks (daily status) -> Missions (frozen daily snapshot of a
 *   plan's current item) -> Plans (uploaded curriculum/template) ->
 *   History (append-only record) -> Recovery Sessions (a plan's
 *   output). Recovery Engine math still lives entirely in
 *   recoveryEngine.js as a pure function of its inputs; this file
 *   only feeds it data (now including a dynamically-computed
 *   priority order and category list) and saves the result.
 *
 * SCHEMA VERSIONING (new): `meta.version` now actually does
 * something. `_runMigrations()` applies any migration whose version
 * is newer than the stored state's version, in order, so a future
 * schema change has a real, tested mechanism to build on instead of
 * relying on `_mergeDefaults` alone (which only fills in missing
 * keys — it can't transform existing data into a new shape).
 * ------------------------------------------------------------
 */

const SCHEMA_VERSION = 2;
const STORAGE_KEY = 'adaptiveOS.v1';

// The only valid task statuses. Anything else passed to
// setTaskStatus() is rejected rather than silently stored.
const VALID_STATUSES = ['not_started', 'in_progress', 'completed', 'deferred', 'skipped', 'recovery_planned'];

const DEFAULT_STATE = {
  meta: {
    createdAt: null,
    lastOpenedAt: null,
    version: SCHEMA_VERSION
  },

  // Local device lock — a PIN gate, not a real account (no server).
  auth: null,

  settings: {
    energyDefault: 'medium',
    eveningRecoveryLimitMinutes: 90,
    dinnerMinutes: 30,
    windDownMinutes: 15,
    targetSleepMinutes: 1350 // 10:30 PM, minutes since midnight
  },

  // Track Registry — every learning track (sequential Week/Topic
  // curriculum). Workout is NOT here; it's a fixed, structurally
  // different category handled on its own throughout this file.
  // python/english/startup ship pre-seeded so existing behavior
  // (and existing users' data, keyed by these exact ids) keeps
  // working unchanged.
  tracks: {
    python: { label: 'Python Learning', icon: 'λ', createdAt: null, archived: false },
    english: { label: 'English Learning', icon: '✎', createdAt: null, archived: false },
    startup: { label: 'Startup Learning', icon: '◆', createdAt: null, archived: false }
  },

  // Per-date task status. Keys are dynamic: 'workout' plus whatever
  // learning tracks are currently active — NOT a fixed 4-key shape.
  tasks: {
    // '2026-07-11': {
    //   workout:  { status: 'not_started', mode: 'standard', updatedAt: null, ... },
    //   python:   { status: 'not_started', mode: 'standard', updatedAt: null, ... },
    //   ... one entry per active track ...
    // }
  },

  // Uploaded learning / workout plans.
  // learning tracks: { raw, uploadedAt, weeks, flatTopics, cursorIndex, completedTopics }
  // workout:         { raw, uploadedAt, days: { monday: {label, detail}, ..., sunday: {...} } }
  plans: {
    workout: null
    // learning track plans are added dynamically, keyed by track id
  },

  // Missions generated once per day per plan-backed category. Each
  // is a frozen snapshot of what that day's task actually is.
  missions: {},

  streaks: {
    current: 0,
    longest: 0,
    lastCompletedDate: null
  },

  // Daily history — end-of-day review answers + completion snapshot.
  history: {
    // '2026-07-11': {
    //   completedPct, completed: [], missed: [], deferred: [],
    //   realityScore: { score, label } | null,
    //   review: { completed: [], missed: [], reasons: {...}, submittedAt } | null
    // }
  },

  // Recovery sessions generated by the Recovery Planner. One record
  // per day, kept separate from live task state.
  recoverySessions: {
    // '2026-07-11': {
    //   workEndTime, energyLevel, includeWorkoutRecovery,
    //   availableTime: {...}, scheduled: [...], deferred: [...],
    //   workoutNeedsResume, generatedAt
    // }
  }
};

/**
 * Schema migrations. Each entry's `migrate(state)` transforms state
 * from the version just below it up to itself, and MUST be
 * idempotent (safe to run on already-migrated data) since
 * `_mergeDefaults` may have already filled in some of the same
 * fields with defaults before a migration runs.
 */
const MIGRATIONS = [
  {
    version: 2,
    description: 'Introduce the Learning Hub track registry and formal schema versioning.',
    migrate(state) {
      // _mergeDefaults already backfills `state.tracks` from
      // DEFAULT_STATE if it was entirely absent (pre-v2 data never
      // had this key), so this is mostly a safety net for the case
      // where it exists but is empty for some other reason — plus
      // establishing a real, tested example for future migrations
      // to follow.
      if (!state.tracks || Object.keys(state.tracks).length === 0) {
        state.tracks = JSON.parse(JSON.stringify(DEFAULT_STATE.tracks));
      }
      return state;
    }
  }
];

function _runMigrations(state) {
  const startVersion = (state.meta && state.meta.version) || 1;
  MIGRATIONS
    .filter(m => m.version > startVersion)
    .sort((a, b) => a.version - b.version)
    .forEach(m => {
      state = m.migrate(state);
      state.meta.version = m.version;
    });
  return state;
}

const Storage = (() => {

  function _read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.error('Storage read failed, resetting state.', e);
      return null;
    }
  }

  function _write(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('Storage write failed.', e);
      return false;
    }
  }

  /**
   * Deep-merges stored data with DEFAULT_STATE so new fields added
   * in later versions don't clobber existing data.
   *
   * This merges the *union* of keys from both `defaults` and
   * `stored` — a key that only exists in `stored` (a real date in
   * `tasks`, a real category in `missions`) is preserved as-is
   * instead of being dropped, which matters because DEFAULT_STATE's
   * dynamic dictionaries (tasks/missions/history/recoverySessions)
   * necessarily start as `{}` with zero keys of their own.
   */
  function _mergeDefaults(stored, defaults) {
    if (Array.isArray(defaults)) {
      return Array.isArray(stored) ? stored : [...defaults];
    }
    if (typeof defaults !== 'object' || defaults === null) {
      return stored !== undefined ? stored : defaults;
    }

    const out = { ...defaults };
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;

    const allKeys = new Set([...Object.keys(defaults), ...Object.keys(stored)]);
    allKeys.forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(stored, key)) return; // nothing stored — keep the default
      const defaultVal = defaults[key];
      const storedVal = stored[key];
      const bothAreMergeableObjects =
        defaultVal !== undefined &&
        typeof defaultVal === 'object' && defaultVal !== null && !Array.isArray(defaultVal) &&
        typeof storedVal === 'object' && storedVal !== null && !Array.isArray(storedVal);

      out[key] = bothAreMergeableObjects ? _mergeDefaults(storedVal, defaultVal) : storedVal;
    });

    return out;
  }

  function init() {
    const stored = _read();
    let state = _mergeDefaults(stored || {}, DEFAULT_STATE);
    state = _runMigrations(state);
    if (!state.meta.createdAt) state.meta.createdAt = new Date().toISOString();
    state.meta.lastOpenedAt = new Date().toISOString();
    _write(state);
    return state;
  }

  function getState() {
    return _read() || init();
  }

  function setState(state) {
    return _write(state);
  }

  function get(path) {
    const state = getState();
    return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), state);
  }

  function set(path, value) {
    const state = getState();
    const keys = path.split('.');
    let cursor = state;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof cursor[keys[i]] !== 'object' || cursor[keys[i]] === null) {
        cursor[keys[i]] = {};
      }
      cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = value;
    setState(state);
    return value;
  }

  function todayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // ------------------------------------------------------------
  // TRACK REGISTRY (Learning Hub)
  // ------------------------------------------------------------

  function _slugify(label) {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  /** Every track (active by default; pass true to include archived
   *  ones too), as an array of { id, label, icon, createdAt, archived }. */
  function getTracks(includeArchived = false) {
    const tracks = getState().tracks || {};
    return Object.entries(tracks)
      .filter(([, t]) => includeArchived || !t.archived)
      .map(([id, t]) => ({ id, ...t }));
  }

  function getActiveTrackIds() {
    return getTracks(false).map(t => t.id);
  }

  /** Every plan-backed category — every active learning track, plus
   *  'workout'. Replaces the old hardcoded PLAN_CATEGORIES constant. */
  function getPlanCategories() {
    return [...getActiveTrackIds(), 'workout'];
  }

  /** Adds a new learning track (or reactivates an archived one with
   *  the same name). Returns the track's id, or null if the label
   *  was empty. New tracks immediately get the full plan-upload /
   *  mission / progress-tracking experience — no new code needed. */
  function addTrack(label) {
    const trimmed = (label || '').trim();
    if (!trimmed) return null;
    const id = _slugify(trimmed);
    if (!id) return null;

    const state = getState();
    if (state.tracks[id]) {
      state.tracks[id].archived = false;
      state.tracks[id].label = trimmed;
    } else {
      state.tracks[id] = {
        label: trimmed,
        icon: '◆',
        createdAt: new Date().toISOString(),
        archived: false
      };
    }
    setState(state);
    return id;
  }

  /** Hides a track from the registry without deleting its data — its
   *  plan, progress, and history all stay intact in case it's
   *  restored later. */
  function archiveTrack(trackId) {
    const state = getState();
    if (!state.tracks[trackId]) return false;
    state.tracks[trackId].archived = true;
    setState(state);
    return true;
  }

  function restoreTrack(trackId) {
    const state = getState();
    if (!state.tracks[trackId]) return false;
    state.tracks[trackId].archived = false;
    setState(state);
    return true;
  }

  // ------------------------------------------------------------
  // TASK API
  // ------------------------------------------------------------

  function _blankTaskEntry() {
    return {
      status: 'not_started',
      mode: 'standard',
      updatedAt: null,
      startedAt: null,
      completedAt: null,
      // True once this task has passed through 'recovery_planned' on
      // this date, even if it's later completed/undone — this is
      // what lets Recovery Success Rate be computed later.
      recoveryPlannedToday: false
    };
  }

  /** Ensures a date's task entry exists AND has a blank entry for
   *  every currently-active category (workout + each active track).
   *  Runs this check every call, not just on first creation — so a
   *  track added after a date's entry already existed still gets a
   *  blank slot for that date instead of silently having no status. */
  function ensureTasksFor(dateKey) {
    const state = getState();
    if (!state.tasks[dateKey]) state.tasks[dateKey] = {};

    const categories = getPlanCategories().includes('workout')
      ? getPlanCategories()
      : [...getPlanCategories(), 'workout'];
    let changed = false;
    categories.forEach(cat => {
      if (!state.tasks[dateKey][cat]) {
        state.tasks[dateKey][cat] = _blankTaskEntry();
        changed = true;
      }
    });

    if (changed) setState(state);
    return state.tasks[dateKey];
  }

  function ensureTodayTasks() {
    return ensureTasksFor(todayKey());
  }

  function getTask(taskKey, dateKey = todayKey()) {
    const dayTasks = ensureTasksFor(dateKey);
    return dayTasks[taskKey] || _blankTaskEntry();
  }

  function setTaskStatus(taskKey, status, dateKey = todayKey()) {
    if (!VALID_STATUSES.includes(status)) {
      console.error(`Invalid task status: "${status}"`);
      return null;
    }

    const state = getState();
    ensureTasksFor(dateKey); // make sure every category has a slot first
    const freshState = getState(); // ensureTasksFor may have just persisted new slots

    const entry = freshState.tasks[dateKey][taskKey] || _blankTaskEntry();
    const prevStatus = entry.status;
    const now = new Date().toISOString();

    entry.status = status;
    entry.updatedAt = now;
    if (status === 'in_progress' && !entry.startedAt) entry.startedAt = now;
    if (status === 'completed') entry.completedAt = now;
    if (status !== 'completed') entry.completedAt = null;
    if (status === 'recovery_planned') entry.recoveryPlannedToday = true;

    freshState.tasks[dateKey][taskKey] = entry;
    setState(freshState);

    _recordHistorySnapshot(dateKey, freshState.tasks[dateKey]);

    // Plan-backed categories: advance the curriculum/session cursor
    // when a mission is completed, and roll it back if that
    // completion is undone.
    if (getPlanCategories().includes(taskKey)) {
      generateMissionsFor(dateKey);
      if (status === 'completed' && prevStatus !== 'completed') {
        _advancePlanCursor(taskKey, dateKey);
      } else if (prevStatus === 'completed' && status !== 'completed') {
        _rollbackPlanCursor(taskKey, dateKey);
      }
    }

    _refreshRealityScore(dateKey);

    return entry;
  }

  function setTaskMode(taskKey, mode, dateKey = todayKey()) {
    const state = getState();
    ensureTasksFor(dateKey);
    const freshState = getState();
    const entry = freshState.tasks[dateKey][taskKey] || _blankTaskEntry();
    entry.mode = mode;
    freshState.tasks[dateKey][taskKey] = entry;
    setState(freshState);
    return entry;
  }

  function getCompletionStats(dateKey = todayKey()) {
    const dayTasks = ensureTasksFor(dateKey);
    const categories = Object.keys(dayTasks);
    const completed = categories.filter(k => dayTasks[k].status === 'completed').length;
    const total = categories.length;
    return { completed, total, pct: total === 0 ? 0 : Math.round((completed / total) * 100) };
  }

  function getRemainingMinutes(dateKey = todayKey()) {
    const dayTasks = ensureTasksFor(dateKey);
    let minutes = 0;
    Object.keys(dayTasks).forEach(key => {
      const task = dayTasks[key];
      if (task.status === 'completed' || task.status === 'skipped') return;
      minutes += (typeof UI !== 'undefined') ? UI.estimateMinutes(key, task.mode) : 0;
    });
    return minutes;
  }

  // ------------------------------------------------------------
  // PLAN API
  // ------------------------------------------------------------

  /** Parses and stores a pasted plan for a category, replacing
   *  whatever was there before. Progress restarts with the new plan. */
  function savePlan(category, rawText) {
    if (!getPlanCategories().includes(category)) {
      console.error(`Unknown plan category: "${category}"`);
      return null;
    }

    const state = getState();

    if (category === 'workout') {
      const parsed = PlanEngine.parseWorkoutPlan(rawText);
      state.plans.workout = {
        raw: rawText,
        uploadedAt: new Date().toISOString(),
        days: parsed.days
      };
    } else {
      const parsed = PlanEngine.parseTopicPlan(rawText);
      state.plans[category] = {
        raw: rawText,
        uploadedAt: new Date().toISOString(),
        weeks: parsed.weeks,
        flatTopics: parsed.flatTopics,
        cursorIndex: 0,
        completedTopics: []
      };
    }

    const today = todayKey();
    if (state.missions[today]) delete state.missions[today][category];

    setState(state);
    generateMissionsFor(today);
    return state.plans[category];
  }

  function getPlan(category) {
    return getState().plans[category] || null;
  }

  function hasPlan(category) {
    return !!getPlan(category);
  }

  // ------------------------------------------------------------
  // MISSION API
  // ------------------------------------------------------------

  /** Normalizes a workout day entry to { label, detail } regardless
   *  of whether it was saved before or after detail-tracking was
   *  added — plans uploaded under the old format stored a bare
   *  string per day. */
  function _normalizeWorkoutDay(entry) {
    if (typeof entry === 'string') return { label: entry, detail: [] };
    return entry || { label: 'Rest', detail: [] };
  }

  /** Ensures today's (or a given day's) mission exists for every
   *  plan-backed category that has a plan uploaded. Idempotent —
   *  safe to call from every view's render(). Always persists, even
   *  if nothing changed this call, so a fresh read immediately
   *  afterward never finds missions[dateKey] missing entirely. */
  function generateMissionsFor(dateKey = todayKey()) {
    const state = getState();
    if (!state.missions[dateKey]) state.missions[dateKey] = {};

    getPlanCategories().forEach(category => {
      if (state.missions[dateKey][category]) return; // already generated
      const plan = state.plans[category];
      if (!plan) return; // nothing uploaded yet

      if (category === 'workout') {
        const [y, m, d] = dateKey.split('-').map(Number);
        const dayName = PlanEngine.dayNameFor(new Date(y, m - 1, d));
        const dayEntry = _normalizeWorkoutDay(plan.days[dayName]);
        state.missions[dateKey][category] = {
          type: 'workout',
          day: dayName,
          label: dayEntry.label,
          detail: dayEntry.detail,
          isRest: PlanEngine.isRestLabel(dayEntry.label),
          generatedAt: new Date().toISOString(),
          advanced: false
        };
      } else {
        const idx = plan.cursorIndex || 0;
        const next = plan.flatTopics[idx] || null;
        state.missions[dateKey][category] = {
          type: 'topic',
          week: next ? next.week : null,
          topic: next ? next.topic : null,
          isComplete: !next,
          generatedAt: new Date().toISOString(),
          advanced: false
        };
      }
    });

    setState(state);
    return state.missions[dateKey];
  }

  function getMission(category, dateKey = todayKey()) {
    const missionsForDay = generateMissionsFor(dateKey);
    return missionsForDay[category] || null;
  }

  function _advancePlanCursor(category, dateKey) {
    const state = getState();
    const mission = state.missions[dateKey] && state.missions[dateKey][category];
    const plan = state.plans[category];
    if (!mission || !plan || mission.advanced) return;

    if (category !== 'workout' && mission.topic) {
      plan.completedTopics = plan.completedTopics || [];
      plan.completedTopics.push({ week: mission.week, topic: mission.topic, completedAt: new Date().toISOString() });
      plan.cursorIndex = (plan.cursorIndex || 0) + 1;
    }
    mission.advanced = true;

    state.missions[dateKey][category] = mission;
    state.plans[category] = plan;
    setState(state);
  }

  function _rollbackPlanCursor(category, dateKey) {
    const state = getState();
    const mission = state.missions[dateKey] && state.missions[dateKey][category];
    const plan = state.plans[category];
    if (!mission || !plan || !mission.advanced) return;

    if (category !== 'workout' && mission.topic) {
      plan.completedTopics = (plan.completedTopics || [])
        .filter(t => !(t.week === mission.week && t.topic === mission.topic));
      plan.cursorIndex = Math.max(0, (plan.cursorIndex || 1) - 1);
    }
    mission.advanced = false;

    state.missions[dateKey][category] = mission;
    state.plans[category] = plan;
    setState(state);
  }

  function getTopicPlanProgress(category) {
    const plan = getPlan(category);
    if (!plan) return null;

    const total = plan.flatTopics.length;
    const completed = plan.completedTopics.length;
    const remaining = Math.max(0, total - completed);
    const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
    const cursorIdx = plan.cursorIndex || 0;

    return {
      total,
      completed,
      remaining,
      pct,
      currentTopic: plan.flatTopics[cursorIdx] || null,
      remainingTopics: plan.flatTopics.slice(cursorIdx),
      completedTopics: plan.completedTopics
    };
  }

  function getWorkoutStats() {
    const plan = getPlan('workout');
    const stats = {
      hasPlan: !!plan,
      scheduled: 0,
      completed: 0,
      missed: 0,
      consistencyPct: 0,
      todayLabel: null,
      todayDetail: [],
      todayDay: null,
      isRestToday: true,
      missedThisWeek: []
    };
    if (!plan) return stats;

    const today = new Date();
    stats.todayDay = PlanEngine.dayNameFor(today);
    const todayEntry = _normalizeWorkoutDay(plan.days[stats.todayDay]);
    stats.todayLabel = todayEntry.label;
    stats.todayDetail = todayEntry.detail;
    stats.isRestToday = PlanEngine.isRestLabel(todayEntry.label);

    const state = getState();
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dKey = todayKey(d);
      const dayName = PlanEngine.dayNameFor(d);
      const label = _normalizeWorkoutDay(plan.days[dayName]).label;
      if (PlanEngine.isRestLabel(label)) continue;

      stats.scheduled += 1;
      const dayTask = state.tasks[dKey] && state.tasks[dKey].workout;
      const status = dayTask ? dayTask.status : 'not_started';
      if (status === 'completed') stats.completed += 1;
      else if (status === 'skipped' || status === 'deferred') stats.missed += 1;
    }
    stats.consistencyPct = stats.scheduled === 0 ? 0 : Math.round((stats.completed / stats.scheduled) * 100);

    // "Missed This Week" — tracked against the actual calendar week
    // (Monday–Sunday containing today). Missing a day never
    // reschedules anything — this is purely visibility.
    const dayOfWeekMon0 = (today.getDay() + 6) % 7;
    const monday = new Date(today);
    monday.setDate(today.getDate() - dayOfWeekMon0);

    for (let i = 0; i < dayOfWeekMon0; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const dKey = todayKey(d);
      const dayName = PlanEngine.dayNameFor(d);
      const dayEntry = _normalizeWorkoutDay(plan.days[dayName]);
      if (PlanEngine.isRestLabel(dayEntry.label)) continue;

      const dayTask = state.tasks[dKey] && state.tasks[dKey].workout;
      const status = dayTask ? dayTask.status : 'not_started';
      if (status !== 'completed') {
        stats.missedThisWeek.push({ day: dayName, label: dayEntry.label, status });
      }
    }

    return stats;
  }

  // ------------------------------------------------------------
  // RECOVERY ENGINE API
  // ------------------------------------------------------------

  /** Recovery priority order: every active learning track (in
   *  registry order), then 'workout' last — the reverse of the
   *  morning order, and workout only ever gets recovered if
   *  explicitly opted in. Computed fresh from the live registry on
   *  every call instead of a fixed constant. */
  function getRecoveryPriority() {
    return [...getActiveTrackIds(), 'workout'];
  }

  function generateRecoveryPlan(input, dateKey = todayKey()) {
    const { workEndTime, energyLevel = 'medium', includeWorkoutRecovery = false } = input || {};
    if (!workEndTime) {
      console.error('generateRecoveryPlan requires a workEndTime ("HH:MM").');
      return null;
    }
    if (typeof RecoveryEngine === 'undefined' || typeof UI === 'undefined') {
      console.error('generateRecoveryPlan requires RecoveryEngine and UI to be loaded.');
      return null;
    }

    const workEndMinutes = UI.timeStrToMinutes(workEndTime);
    const state = getState();
    const s = state.settings;

    const availableTime = RecoveryEngine.computeAvailableTime(workEndMinutes, {
      dinnerMinutes: s.dinnerMinutes,
      windDownMinutes: s.windDownMinutes,
      targetSleepMinutes: s.targetSleepMinutes
    });
    const cappedMinutes = Math.min(availableTime.availableMinutes, s.eveningRecoveryLimitMinutes);
    const schedulingBudget = Math.max(0, cappedMinutes - RecoveryEngine.DEFAULTS.transitionBufferMinutes);

    const dayTasks = ensureTasksFor(dateKey);
    const candidateCategories = [...getActiveTrackIds()];
    if (includeWorkoutRecovery) candidateCategories.push('workout');

    const candidates = candidateCategories.filter(c => {
      const status = dayTasks[c] ? dayTasks[c].status : 'not_started';
      return status !== 'completed' && status !== 'skipped';
    });

    const result = RecoveryEngine.buildRecoveryPlan({
      candidates,
      priorityOrder: getRecoveryPriority(),
      availableMinutes: schedulingBudget,
      recoveryStartMinutes: availableTime.recoveryStart,
      energyLevel
    });

    result.scheduled.forEach(item => {
      setTaskStatus(item.category, 'recovery_planned', dateKey);
      setTaskMode(item.category, item.mode, dateKey);
    });
    result.deferred.forEach(category => {
      setTaskStatus(category, 'deferred', dateKey);
    });

    const workoutStatus = ensureTasksFor(dateKey).workout.status;
    const workoutNeedsResume = workoutStatus !== 'completed' && !includeWorkoutRecovery;

    const freshState = getState();
    freshState.recoverySessions[dateKey] = {
      workEndTime,
      energyLevel,
      includeWorkoutRecovery,
      availableTime: { ...availableTime, cappedMinutes },
      scheduled: result.scheduled,
      deferred: result.deferred,
      workoutNeedsResume,
      generatedAt: new Date().toISOString()
    };
    setState(freshState);

    _refreshRealityScore(dateKey);
    return getRecoverySession(dateKey);
  }

  function getRecoverySession(dateKey = todayKey()) {
    return getState().recoverySessions[dateKey] || null;
  }

  function _refreshRealityScore(dateKey) {
    if (typeof RecoveryEngine === 'undefined') return;
    const state = getState();
    const dayTasks = state.tasks[dateKey];
    if (!dayTasks) return;
    const categories = ['workout', ...getActiveTrackIds()];
    state.history[dateKey] = {
      ...(state.history[dateKey] || {}),
      realityScore: RecoveryEngine.computeRealityScore(dayTasks, categories)
    };
    setState(state);
  }

  function getRealityScore(dateKey = todayKey()) {
    const entry = getState().history[dateKey];
    if (entry && entry.realityScore) return entry.realityScore;
    const dayTasks = ensureTasksFor(dateKey);
    const categories = ['workout', ...getActiveTrackIds()];
    return (typeof RecoveryEngine !== 'undefined')
      ? RecoveryEngine.computeRealityScore(dayTasks, categories)
      : { score: 40, label: 'Minimal Progress' };
  }

  // ------------------------------------------------------------
  // END-OF-DAY REVIEW API
  // ------------------------------------------------------------

  function submitEndOfDayReview(reasons, dateKey = todayKey()) {
    const state = getState();
    const dayTasks = state.tasks[dateKey] || {};
    const categories = Object.keys(dayTasks);
    const completed = categories.filter(k => dayTasks[k].status === 'completed');
    const missed = categories.filter(k => dayTasks[k].status !== 'completed');

    state.history[dateKey] = {
      ...(state.history[dateKey] || {}),
      review: {
        completed,
        missed,
        reasons: reasons || {},
        submittedAt: new Date().toISOString()
      }
    };
    setState(state);
    _refreshRealityScore(dateKey);
    return state.history[dateKey];
  }

  function getEndOfDayReview(dateKey = todayKey()) {
    const entry = getState().history[dateKey];
    return (entry && entry.review) || null;
  }

  // ------------------------------------------------------------
  // DEFERRED TASK SYSTEM
  // ------------------------------------------------------------

  function getDeferredSummary(daysBack = 14) {
    const state = getState();
    let todayCount = 0;
    const log = [];

    for (let i = 0; i < daysBack; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dKey = todayKey(d);
      const entry = state.history[dKey];
      if (!entry || !entry.deferred || entry.deferred.length === 0) continue;

      entry.deferred.forEach(category => {
        const reason = entry.review && entry.review.reasons ? entry.review.reasons[category] : null;
        log.push({ date: dKey, category, reason: reason || null });
        if (i === 0) todayCount += 1;
      });
    }

    return { todayCount, log };
  }

  // ------------------------------------------------------------
  // RECOVERY ANALYTICS + INSIGHTS AGGREGATES
  // ------------------------------------------------------------

  function getRecoveryAnalytics(daysBack = 7) {
    const state = getState();
    const weeklyTrend = [];
    let recoverySessionsCount = 0;
    let deferredTasksCount = 0;
    let recoveryAttempted = 0;
    let recoverySucceeded = 0;
    const allCategories = ['workout', ...getActiveTrackIds()];

    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dKey = todayKey(d);

      if (state.recoverySessions[dKey]) recoverySessionsCount += 1;

      const historyEntry = state.history[dKey];
      deferredTasksCount += (historyEntry && historyEntry.deferred) ? historyEntry.deferred.length : 0;

      const score = historyEntry && historyEntry.realityScore ? historyEntry.realityScore.score : null;
      weeklyTrend.push({ date: dKey, score });

      const dayTasks = state.tasks[dKey];
      if (dayTasks) {
        allCategories.forEach(k => {
          if (dayTasks[k] && dayTasks[k].recoveryPlannedToday) {
            recoveryAttempted += 1;
            if (dayTasks[k].status === 'completed') recoverySucceeded += 1;
          }
        });
      }
    }

    const recoverySuccessRatePct = recoveryAttempted === 0
      ? null
      : Math.round((recoverySucceeded / recoveryAttempted) * 100);

    return { recoverySessionsCount, deferredTasksCount, recoverySuccessRatePct, weeklyTrend };
  }

  function getLearningVelocity(category, daysBack = 30) {
    const plan = getPlan(category);
    if (!plan) return null;

    const state = getState();
    let activeDays = 0;
    let topicsCompletedInWindow = 0;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);

    (plan.completedTopics || []).forEach(t => {
      if (t.completedAt && new Date(t.completedAt) >= cutoff) topicsCompletedInWindow += 1;
    });

    for (let i = 0; i < daysBack; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dTasks = state.tasks[todayKey(d)];
      if (dTasks && dTasks[category] && dTasks[category].status === 'completed') activeDays += 1;
    }

    const perActiveDay = activeDays === 0 ? 0 : +(topicsCompletedInWindow / activeDays).toFixed(1);
    const remaining = plan.flatTopics.length - plan.completedTopics.length;
    const projectedDays = perActiveDay > 0 ? Math.ceil(remaining / perActiveDay) : null;

    return { perActiveDay, activeDays, remaining, projectedDays };
  }

  function getPeakProductivityWindow(category, daysBack = 30) {
    const state = getState();
    let total = 0;
    let before7pm = 0;
    let after9pm = 0;

    for (let i = 0; i < daysBack; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dTasks = state.tasks[todayKey(d)];
      const task = dTasks && dTasks[category];
      if (!task || task.status !== 'completed' || !task.completedAt) continue;

      total += 1;
      const hour = new Date(task.completedAt).getHours();
      if (hour < 19) before7pm += 1;
      if (hour >= 21) after9pm += 1;
    }

    if (total === 0) return null;
    return {
      total,
      before7pmPct: Math.round((before7pm / total) * 100),
      after9pmPct: Math.round((after9pm / total) * 100)
    };
  }

  function getMissedTaskCauses(daysBack = 60) {
    const state = getState();
    const counts = {};

    for (let i = 0; i < daysBack; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const entry = state.history[todayKey(d)];
      if (!entry || !entry.review || !entry.review.reasons) continue;

      Object.entries(entry.review.reasons).forEach(([category, reason]) => {
        counts[category] = counts[category] || {};
        counts[category][reason] = (counts[category][reason] || 0) + 1;
      });
    }

    const summary = {};
    Object.entries(counts).forEach(([category, reasonCounts]) => {
      const total = Object.values(reasonCounts).reduce((a, b) => a + b, 0);
      const [topReason, topCount] = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0];
      summary[category] = { topReason, topCount, total, pct: Math.round((topCount / total) * 100) };
    });
    return summary;
  }

  // ------------------------------------------------------------
  // EXPORT / IMPORT
  // ------------------------------------------------------------

  function exportDataAsJSON() {
    return JSON.stringify(getState(), null, 2);
  }

  function importDataFromJSON(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      return { ok: false, error: 'That file isn\u2019t valid JSON.' };
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.tasks || !parsed.settings) {
      return { ok: false, error: 'That doesn\u2019t look like an Adaptive OS export.' };
    }
    let merged = _mergeDefaults(parsed, DEFAULT_STATE);
    merged = _runMigrations(merged);
    setState(merged);
    return { ok: true };
  }

  function _recordHistorySnapshot(dateKey, dayTasks) {
    const state = getState();
    const categories = Object.keys(dayTasks);
    const completed = categories.filter(k => dayTasks[k].status === 'completed');
    const deferred = categories.filter(k => dayTasks[k].status === 'deferred');
    const missed = categories.filter(k => dayTasks[k].status === 'skipped');
    const completedPct = categories.length === 0 ? 0 : Math.round((completed.length / categories.length) * 100);

    state.history[dateKey] = {
      ...(state.history[dateKey] || {}),
      completedPct,
      completed,
      deferred,
      missed
    };
    setState(state);
  }

  return {
    SCHEMA_VERSION,
    VALID_STATUSES,
    init,
    getState,
    setState,
    get,
    set,
    todayKey,
    getTracks,
    getActiveTrackIds,
    getPlanCategories,
    addTrack,
    archiveTrack,
    restoreTrack,
    ensureTasksFor,
    ensureTodayTasks,
    getTask,
    setTaskStatus,
    setTaskMode,
    getCompletionStats,
    getRemainingMinutes,
    savePlan,
    getPlan,
    hasPlan,
    generateMissionsFor,
    getMission,
    getTopicPlanProgress,
    getWorkoutStats,
    getRecoveryPriority,
    generateRecoveryPlan,
    getRecoverySession,
    getRealityScore,
    submitEndOfDayReview,
    getEndOfDayReview,
    getDeferredSummary,
    getRecoveryAnalytics,
    getLearningVelocity,
    getPeakProductivityWindow,
    getMissedTaskCauses,
    exportDataAsJSON,
    importDataFromJSON,
    DEFAULT_STATE
  };
})();

/* ===== auth.js ===== */
/**
 * auth.js
 * ------------------------------------------------------------
 * A local device lock — NOT a real account system. There is no
 * server here to check credentials against, so "authentication"
 * means: a PIN gate on top of the same LocalStorage data the rest
 * of the app already uses.
 *
 * The PIN is stored as a simple non-reversible hash (not a proper
 * crypto hash — Web Crypto's subtle.digest requires a "secure
 * context," which file:// pages don't reliably get across every
 * mobile browser). That tradeoff is intentional: portability over
 * cryptographic strength, appropriate for a personal single-user
 * lock rather than a real login.
 * ------------------------------------------------------------
 */

const Auth = (() => {
  const SESSION_KEY = 'adaptiveOS.unlocked';
  const SALT = 'adaptive-os-local-lock-v1';

  function hashPin(pin) {
    const input = SALT + ':' + pin;
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0; // djb2
    }
    return hash.toString(36);
  }

  function getAuthState() {
    return Storage.get('auth');
  }

  function isSetUp() {
    const auth = getAuthState();
    return !!(auth && auth.pinHash);
  }

  function isUnlockedThisSession() {
    return sessionStorage.getItem(SESSION_KEY) === 'true';
  }

  function markUnlocked() {
    sessionStorage.setItem(SESSION_KEY, 'true');
  }

  function markLocked() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  function setupPin(name, pin) {
    Storage.set('auth', {
      name: (name || '').trim() || 'there',
      pinHash: hashPin(pin),
      createdAt: new Date().toISOString()
    });
    markUnlocked();
  }

  /** Requires the current PIN before accepting a new one — used by
   *  the Settings page. Returns true/false; never throws. */
  function changePin(oldPin, newPin) {
    const auth = getAuthState();
    if (!auth || hashPin(oldPin) !== auth.pinHash) return false;
    Storage.set('auth', { ...auth, pinHash: hashPin(newPin) });
    return true;
  }

  function verifyPin(pin) {
    const auth = getAuthState();
    if (!auth) return false;
    if (hashPin(pin) === auth.pinHash) {
      markUnlocked();
      return true;
    }
    return false;
  }

  function getName() {
    const auth = getAuthState();
    return auth ? auth.name : '';
  }

  /** Full local reset — the only recovery path for a forgotten PIN,
   *  since there's no server to verify identity against. Wipes
   *  every bit of app data, AND the service worker's cache and
   *  registration — clearing only localStorage/sessionStorage was
   *  a real bug: it reset data but left a stale, possibly outdated
   *  cached copy of the app itself still in control. */
  async function resetEverything() {
    localStorage.clear();
    sessionStorage.clear();

    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(reg => reg.unregister()));
    }

    location.reload();
  }

  function showOverlay() {
    document.getElementById('authOverlay').style.display = 'flex';
  }

  function hideOverlay() {
    document.getElementById('authOverlay').style.display = 'none';
  }

  function showSetupForm() {
    document.getElementById('authSetupForm').style.display = 'flex';
    document.getElementById('authUnlockForm').style.display = 'none';
  }

  function showUnlockForm() {
    document.getElementById('authSetupForm').style.display = 'none';
    document.getElementById('authUnlockForm').style.display = 'flex';
    document.getElementById('authUnlockGreeting').textContent = `Welcome back, ${getName()}`;
    const pinInput = document.getElementById('authUnlockPin');
    pinInput.value = '';
    setTimeout(() => pinInput.focus(), 50);
  }

  function bindForms() {
    document.getElementById('authSetupForm').addEventListener('submit', e => {
      e.preventDefault();
      const name = document.getElementById('authSetupName').value;
      const pin = document.getElementById('authSetupPin').value;
      const confirmPin = document.getElementById('authSetupPinConfirm').value;
      const errorEl = document.getElementById('authSetupError');

      if (!/^\d{4,6}$/.test(pin)) {
        errorEl.textContent = 'PIN must be 4–6 digits.';
        return;
      }
      if (pin !== confirmPin) {
        errorEl.textContent = 'PINs don\u2019t match.';
        return;
      }
      errorEl.textContent = '';
      setupPin(name, pin);
      hideOverlay();
    });

    document.getElementById('authUnlockForm').addEventListener('submit', e => {
      e.preventDefault();
      const pin = document.getElementById('authUnlockPin').value;
      const errorEl = document.getElementById('authUnlockError');

      if (verifyPin(pin)) {
        errorEl.textContent = '';
        hideOverlay();
      } else {
        errorEl.textContent = 'Incorrect PIN. Try again.';
        document.getElementById('authUnlockPin').value = '';
        document.getElementById('authUnlockPin').focus();
      }
    });

    document.getElementById('authForgotBtn').addEventListener('click', () => {
      const confirmed = confirm(
        'This erases everything on this device — plans, tasks, streaks, history — ' +
        'there is no way to recover a forgotten PIN otherwise. Continue?'
      );
      if (confirmed) resetEverything();
    });

    document.getElementById('topbarLockBtn').addEventListener('click', () => {
      markLocked();
      render();
    });
  }

  function render() {
    if (!isSetUp()) {
      showSetupForm();
      showOverlay();
    } else if (isUnlockedThisSession()) {
      hideOverlay();
    } else {
      showUnlockForm();
      showOverlay();
    }
  }

  function init() {
    bindForms();
    render();
  }

  return { init, isSetUp, isUnlockedThisSession, getName, changePin, lockNow: () => { markLocked(); render(); } };
})();

/* ===== ui.js ===== */
/**
 * ui.js
 * ------------------------------------------------------------
 * Shared, presentation-only helpers used by every page module.
 * No storage access here beyond reading the track registry to
 * keep TASK_ORDER/TASK_META/TASK_MODE_MINUTES in sync — the actual
 * data lives in storage.js.
 *
 * TASK_ORDER / TASK_META / TASK_MODE_MINUTES used to be hardcoded
 * constants (workout/python/english/startup, fixed). They're now
 * mutable objects rebuilt from the live track registry via
 * refreshTaskRegistry() — called on init and after any track is
 * added/archived/restored — so every existing consumer
 * (`UI.TASK_META[key].label`, `UI.TASK_ORDER.forEach(...)`, etc.)
 * keeps working completely unchanged while the underlying data
 * becomes dynamic. This is what lets a user-added learning track
 * slot into the Dashboard, Planner, and Recovery Engine without
 * any of those files needing to change.
 * ------------------------------------------------------------
 */

const UI = (() => {

  const WORKOUT_META = { label: 'Workout', icon: '↯' };
  // Fallback mode-minutes for a newly-added track that hasn't been
  // individually tuned — Python/English keep their original values.
  const TRACK_MODE_DEFAULTS = { minimum: 15, standard: 30, extended: 45 };
  const LEGACY_TRACK_MODE_MINUTES = {
    python: { minimum: 20, standard: 45, extended: 60 },
    english: { minimum: 10, standard: 20, extended: 30 }
  };

  let TASK_ORDER = ['workout'];
  let TASK_META = { workout: WORKOUT_META };
  let TASK_MODE_MINUTES = { workout: { standard: 80 } };

  /** Rebuilds TASK_ORDER/TASK_META/TASK_MODE_MINUTES from the live
   *  track registry. Call this on app init and any time a track is
   *  added, archived, or restored. */
  function refreshTaskRegistry() {
    const tracks = (typeof Storage !== 'undefined') ? Storage.getTracks() : [];

    TASK_ORDER = ['workout', ...tracks.map(t => t.id)];

    TASK_META = { workout: WORKOUT_META };
    tracks.forEach(t => {
      TASK_META[t.id] = { label: t.label, icon: t.icon || '◆' };
    });

    TASK_MODE_MINUTES = { workout: { standard: 80 } };
    tracks.forEach(t => {
      TASK_MODE_MINUTES[t.id] = LEGACY_TRACK_MODE_MINUTES[t.id] || { ...TRACK_MODE_DEFAULTS };
    });
  }

  const STATUS_LABEL = {
    not_started: 'Not started',
    in_progress: 'In progress',
    completed: 'Completed',
    deferred: 'Deferred',
    skipped: 'Skipped',
    recovery_planned: 'Recovery Planned'
  };

  // Which statuses can move to which next status, and what each
  // transition button is labeled. This is the single "task status
  // system" table — every page renders its buttons from this one
  // source instead of each defining their own.
  const TRANSITIONS = {
    not_started: [
      { to: 'in_progress', label: 'Start', variant: 'primary' },
      { to: 'deferred', label: 'Defer', variant: 'amber' },
      { to: 'skipped', label: 'Skip', variant: 'ghost' }
    ],
    in_progress: [
      { to: 'completed', label: 'Complete', variant: 'green' },
      { to: 'deferred', label: 'Defer', variant: 'amber' },
      { to: 'skipped', label: 'Skip', variant: 'ghost' }
    ],
    completed: [
      { to: 'not_started', label: 'Undo', variant: 'text' }
    ],
    deferred: [
      { to: 'in_progress', label: 'Start', variant: 'primary' },
      { to: 'skipped', label: 'Skip', variant: 'ghost' },
      { to: 'not_started', label: 'Undo', variant: 'text' }
    ],
    skipped: [
      { to: 'in_progress', label: 'Start', variant: 'primary' },
      { to: 'not_started', label: 'Undo', variant: 'text' }
    ],
    recovery_planned: [
      { to: 'in_progress', label: 'Start', variant: 'primary' },
      { to: 'completed', label: 'Complete', variant: 'green' },
      { to: 'skipped', label: 'Skip', variant: 'ghost' },
      { to: 'not_started', label: 'Undo', variant: 'text' }
    ]
  };

  const STATUS_DOT_CLASS = {
    not_started: '',
    in_progress: 'is-progress',
    completed: 'is-completed',
    deferred: 'is-deferred',
    skipped: 'is-skipped',
    recovery_planned: 'is-recovery'
  };

  function formatTime(date = new Date()) {
    let h = date.getHours();
    const m = String(date.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  }

  function formatDate(date = new Date()) {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function dayOfWeek(date = new Date()) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }

  function minutesNow(date = new Date()) {
    return date.getHours() * 60 + date.getMinutes();
  }

  function timeStrToMinutes(str) {
    const [h, m] = str.split(':').map(Number);
    return h * 60 + m;
  }

  /** Inverse of timeStrToMinutes, for display: 510 -> '8:30 AM'. */
  function minutesToClockLabel(totalMinutes) {
    const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
    const h24 = Math.floor(wrapped / 60);
    const m = String(wrapped % 60).padStart(2, '0');
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  }

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  let toastTimer = null;
  function toast(message) {
    let node = document.getElementById('osToast');
    if (!node) {
      node = el('div', 'toast');
      node.id = 'osToast';
      node.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: var(--surface-2); border: 1px solid var(--border);
        color: var(--text); padding: 10px 16px; border-radius: 10px;
        font-size: 13px; z-index: 999; opacity: 0; transition: opacity 0.2s ease;
        pointer-events: none;
      `;
      document.body.appendChild(node);
    }
    node.textContent = message;
    requestAnimationFrame(() => { node.style.opacity = '1'; });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.style.opacity = '0'; }, 2200);
  }

  /** Estimated minutes for a task at a given mode, falling back
   *  to that task's standard mode if the requested one isn't defined. */
  function estimateMinutes(taskKey, mode) {
    const modes = TASK_MODE_MINUTES[taskKey] || {};
    return modes[mode] ?? modes.standard ?? 0;
  }

  function renderActionButtonsHTML(taskKey, status) {
    const transitions = TRANSITIONS[status] || [];
    return transitions.map(t => `
      <button class="action-btn action-btn--${t.variant}" data-task="${taskKey}" data-to="${t.to}">
        ${t.label}
      </button>
    `).join('');
  }

  function bindActionButtons(container, onTransition) {
    container.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', () => onTransition(btn.dataset.to));
    });
  }

  function renderModeSelectorHTML(taskKey, task) {
    const modes = Object.keys(TASK_MODE_MINUTES[taskKey] || {});
    if (modes.length <= 1) return '';

    const isLocked = task.status === 'completed' || task.status === 'skipped';
    const buttons = modes.map(mode => `
      <button
        class="mode-btn ${task.mode === mode ? 'is-active' : ''}"
        data-mode="${mode}"
        ${isLocked ? 'disabled' : ''}
      >${mode}</button>
    `).join('');

    return `<div class="mode-selector" data-task="${taskKey}">${buttons}</div>`;
  }

  function bindModeSelector(container, onModeChange) {
    const el = container.querySelector('.mode-selector');
    if (!el) return;
    el.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => onModeChange(btn.dataset.mode));
    });
  }

  /** Renders a workout mission's structured detail (muscle-group
   *  headers + exercise lists) as HTML. Shared by the Fitness page
   *  and the Today Hero card. */
  function renderWorkoutDetailGroups(groups) {
    if (!groups || groups.length === 0) {
      return '<p class="workout-detail__empty">No exercise breakdown for this session.</p>';
    }
    return groups.map(g => `
      <div class="workout-detail__group">
        ${g.group ? `<h3 class="workout-detail__group-title">${g.group}</h3>` : ''}
        <ul class="workout-detail__exercises">
          ${g.exercises.map(ex => `<li>${ex}</li>`).join('')}
        </ul>
      </div>
    `).join('');
  }

  return {
    get TASK_ORDER() { return TASK_ORDER; },
    get TASK_META() { return TASK_META; },
    get TASK_MODE_MINUTES() { return TASK_MODE_MINUTES; },
    refreshTaskRegistry,
    STATUS_LABEL,
    TRANSITIONS,
    STATUS_DOT_CLASS,
    estimateMinutes,
    renderActionButtonsHTML,
    bindActionButtons,
    renderModeSelectorHTML,
    bindModeSelector,
    renderWorkoutDetailGroups,
    formatTime,
    formatDate,
    dayOfWeek,
    minutesNow,
    timeStrToMinutes,
    minutesToClockLabel,
    el,
    toast
  };
})();

/* ===== dashboard.js ===== */
/**
 * dashboard.js
 * ------------------------------------------------------------
 * Renders the status/momentum portions of the "Today" view: the
 * live clock, the (collapsible) Day Rail, the completion ring +
 * status pill, the (collapsible) Weekly Progress chart, the
 * streak, and the Recovery card. The full task list is rendered
 * by planner.js (#plannerTaskGrid, embedded in the same Today
 * view), and the "what's next" Hero card + onboarding checklist +
 * Recovery Prompt banner are rendered by today.js.
 *
 * Streak logic lives here (maybeUpdateStreak) and is exported so
 * every page that changes a task's status can trigger the same
 * check.
 * ------------------------------------------------------------
 */

const Dashboard = (() => {

  const MORNING_SCHEDULE = [
    { label: 'Wake Up', start: 390, end: 400 },
    { label: 'Workout', start: 400, end: 480 },
    { label: 'Shower', start: 480, end: 495 },
    { label: 'Breakfast', start: 495, end: 510 },
    { label: 'Python Learning + Practice', start: 510, end: 555 },
    { label: 'Leave For Work', start: 555, end: 570 }
  ];

  function renderClock() {
    const now = new Date();
    document.getElementById('liveTime').textContent = UI.formatTime(now);
    document.getElementById('liveDate').textContent = UI.formatDate(now);
    document.getElementById('dayOfWeek').textContent = UI.dayOfWeek(now);
  }

  function renderDayRail() {
    const rail = document.getElementById('dayRail');
    rail.innerHTML = '';
    const nowMin = UI.minutesNow();

    MORNING_SCHEDULE.forEach(block => {
      let state = 'is-upcoming';
      if (nowMin >= block.end) state = 'is-done';
      else if (nowMin >= block.start && nowMin < block.end) state = 'is-now';

      const node = UI.el('div', `day-rail__block ${state}`, `
        <span class="day-rail__time">${UI.minutesToClockLabel(block.start)}–${UI.minutesToClockLabel(block.end)}</span>
        <span class="day-rail__label">${block.label}</span>
      `);
      rail.appendChild(node);
    });
  }

  function updateCompletion() {
    const { completed, total, pct } = Storage.getCompletionStats();
    const todayTasks = Storage.ensureTodayTasks();

    document.getElementById('completionPct').textContent = `${pct}%`;
    document.getElementById('completedCount').textContent = `${completed} / ${total} tasks`;
    document.getElementById('completionRing').style.setProperty('--pct', pct);

    const pill = document.getElementById('statusPill');
    if (pct === 100) {
      pill.textContent = 'All Done';
      pill.className = 'pill';
    } else if (UI.TASK_ORDER.some(k => todayTasks[k] && todayTasks[k].status === 'recovery_planned')) {
      pill.textContent = 'Recovering';
      pill.className = 'pill is-violet';
    } else if (UI.TASK_ORDER.some(k => todayTasks[k] && todayTasks[k].status === 'deferred')) {
      pill.textContent = 'Needs Recovery';
      pill.className = 'pill is-amber';
    } else {
      pill.textContent = 'On Track';
      pill.className = 'pill';
    }
  }

  function renderRecoveryCard() {
    const container = document.getElementById('recoveryCard');
    const hint = document.getElementById('recoveryCardHint');
    const session = Storage.getRecoverySession();
    const scoreInfo = Storage.getRealityScore();
    const deferredSummary = Storage.getDeferredSummary();

    hint.textContent = `Score: ${scoreInfo.score}`;

    const scoreRow = `
      <div class="recovery-card__score">
        <span class="recovery-card__score-value">${scoreInfo.score}</span>
        <span class="recovery-card__score-label">${scoreInfo.label}</span>
      </div>
    `;

    let bodyHtml;
    if (!session) {
      bodyHtml = `<p class="recovery-suggestion__text">No recovery plan yet today. Open <strong>Recovery</strong> once work ends to reorganize the evening.</p>`;
    } else {
      const workEndLabel = UI.minutesToClockLabel(UI.timeStrToMinutes(session.workEndTime));
      const scheduleRows = session.scheduled.length
        ? session.scheduled.map(item => `
            <div class="recovery-plan__row">
              <span class="recovery-plan__time">${UI.minutesToClockLabel(item.startMinutes)}</span>
              <span>${UI.TASK_META[item.category] ? UI.TASK_META[item.category].label : item.category} — ${item.mode} (${item.minutes}m)</span>
            </div>
          `).join('')
        : `<p class="recovery-suggestion__text">Nothing needed recovery tonight.</p>`;

      bodyHtml = `
        <p class="recovery-card__meta">Work ended <strong>${workEndLabel}</strong></p>
        <div class="recovery-plan">${scheduleRows}</div>
      `;
    }

    const deferredHtml = deferredSummary.todayCount > 0
      ? `<p class="recovery-card__deferred">${deferredSummary.todayCount} task${deferredSummary.todayCount === 1 ? '' : 's'} deferred today</p>`
      : '';

    container.innerHTML = scoreRow + bodyHtml + deferredHtml;
  }

  function renderWeeklyChart() {
    const chart = document.getElementById('weeklyChart');
    chart.innerHTML = '';
    const state = Storage.getState();

    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = Storage.todayKey(d);
      const dayTasks = state.tasks[key];
      let pct = 0;
      if (dayTasks) {
        const categories = Object.keys(dayTasks);
        const completed = categories.filter(k => dayTasks[k] && dayTasks[k].status === 'completed').length;
        pct = categories.length === 0 ? 0 : Math.round((completed / categories.length) * 100);
      }
      days.push({ label: d.toLocaleDateString('en-US', { weekday: 'narrow' }), pct, isToday: i === 0 });
    }

    const avg = Math.round(days.reduce((a, d) => a + d.pct, 0) / days.length);
    document.getElementById('weeklyAvg').textContent = `${avg}% avg`;

    days.forEach(day => {
      const col = UI.el('div', `bar-chart__col ${day.isToday ? 'is-today' : ''}`, `
        <div class="bar-chart__track"><div class="bar-chart__fill" style="height:${day.pct}%"></div></div>
        <span class="bar-chart__label">${day.label}</span>
      `);
      chart.appendChild(col);
    });
  }

  function renderStreak() {
    const state = Storage.getState();
    document.querySelector('#navStreak .nav__streak-num').textContent = state.streaks.current;
  }

  function maybeUpdateStreak() {
    const todayTasks = Storage.ensureTodayTasks();
    const allDone = UI.TASK_ORDER.every(k => todayTasks[k] && todayTasks[k].status === 'completed');
    const state = Storage.getState();
    const today = Storage.todayKey();

    if (allDone && state.streaks.lastCompletedDate !== today) {
      state.streaks.current += 1;
      state.streaks.longest = Math.max(state.streaks.longest, state.streaks.current);
      state.streaks.lastCompletedDate = today;
      Storage.setState(state);
    } else if (!allDone && state.streaks.lastCompletedDate === today) {
      state.streaks.current = Math.max(0, state.streaks.current - 1);
      state.streaks.lastCompletedDate = null;
      Storage.setState(state);
    }
    renderStreak();
  }

  function render() {
    Storage.generateMissionsFor(Storage.todayKey());
    renderClock();
    renderDayRail();
    updateCompletion();
    renderWeeklyChart();
    renderRecoveryCard();
    renderStreak();
  }

  function init() {
    render();
    setInterval(() => { renderClock(); renderDayRail(); }, 30000);
    setInterval(render, 5 * 60000);
  }

  return { init, render, maybeUpdateStreak };
})();

/* ===== planner.js ===== */
/**
 * planner.js
 * ------------------------------------------------------------
 * Renders the full task grid embedded in the Today view. Every
 * read/write goes through Storage's Task API, and every
 * button/segmented-control it draws comes from UI's shared
 * renderers — the same ones the Fitness and Learning pages use, so
 * the status-transition system exists in exactly one place.
 *
 * Iterates UI.TASK_ORDER, which is now dynamically derived from
 * the track registry — so this file needs zero changes when a
 * track is added or archived.
 * ------------------------------------------------------------
 */

const Planner = (() => {

  function renderProgressSummary() {
    const { completed, total, pct } = Storage.getCompletionStats();
    const remainingMin = Storage.getRemainingMinutes();
    const todayTasks = Storage.ensureTodayTasks();
    const deferredCount = UI.TASK_ORDER.filter(k => todayTasks[k] && todayTasks[k].status === 'deferred').length;

    document.getElementById('plannerPct').textContent = `${pct}%`;
    document.getElementById('plannerProgressFill').style.width = `${pct}%`;
    document.getElementById('plannerCompletedCount').textContent = `${completed} / ${total}`;
    document.getElementById('plannerRemaining').textContent = `${remainingMin} min`;
    document.getElementById('plannerDeferredCount').textContent = String(deferredCount);
  }

  function renderTaskCard(taskKey) {
    const task = Storage.getTask(taskKey);
    const meta = UI.TASK_META[taskKey];
    if (!meta) return null; // track was archived after today's tasks were created

    const minutes = UI.estimateMinutes(taskKey, task.mode);
    const dotClass = UI.STATUS_DOT_CLASS[task.status];
    const isDone = task.status === 'completed' || task.status === 'skipped';

    const card = UI.el('div', `planner-card ${isDone ? 'is-settled' : ''}`, `
      <div class="planner-card__top">
        <div class="planner-card__title">
          <span class="task-item__dot ${dotClass}"></span>
          <span class="planner-card__icon">${meta.icon}</span>
          <span class="planner-card__name">${meta.label}</span>
        </div>
        <span class="planner-card__status">${UI.STATUS_LABEL[task.status]}</span>
      </div>

      ${UI.renderModeSelectorHTML(taskKey, task)}

      <div class="planner-card__meta">
        <span>${task.status === 'completed' ? 'Done' : task.status === 'skipped' ? 'Skipped for today' : `Est. ${minutes} min`}</span>
      </div>

      <div class="planner-card__actions">
        ${UI.renderActionButtonsHTML(taskKey, task.status)}
      </div>
    `);

    UI.bindModeSelector(card, mode => {
      Storage.setTaskMode(taskKey, mode);
      renderAll();
    });

    UI.bindActionButtons(card, toStatus => {
      Storage.setTaskStatus(taskKey, toStatus);
      UI.toast(`${meta.label} → ${UI.STATUS_LABEL[toStatus]}`);
      if (typeof Dashboard !== 'undefined') Dashboard.maybeUpdateStreak();
      renderAll();
    });

    return card;
  }

  function renderTaskGrid() {
    const grid = document.getElementById('plannerTaskGrid');
    grid.innerHTML = '';
    UI.TASK_ORDER.forEach(key => {
      const card = renderTaskCard(key);
      if (card) grid.appendChild(card);
    });
  }

  function renderAll() {
    Storage.generateMissionsFor(Storage.todayKey());
    renderProgressSummary();
    renderTaskGrid();
  }

  function init() {
    renderAll();
  }

  return { init, render: renderAll };
})();

/* ===== workoutManager.js ===== */
/**
 * workoutManager.js
 * ------------------------------------------------------------
 * Workout Manager (Fitness page). Structurally different from
 * learning tracks (a weekday template, not a sequential topic
 * list), so this isn't built from the topic-plan factory — but it
 * still shares the same parsing engine, status system, and mission
 * generation as everything else. Not part of the track registry:
 * workout is a fixed, special-cased category throughout the app.
 * ------------------------------------------------------------
 */

const WorkoutManager = (() => {
  const CATEGORY = 'workout';

  function capitalize(word) {
    return word ? word.charAt(0).toUpperCase() + word.slice(1) : '';
  }

  const MISSED_STATUS_LABEL = {
    deferred: 'Deferred',
    skipped: 'Skipped',
    not_started: 'Not started',
    in_progress: 'In progress',
    recovery_planned: 'Recovery Planned'
  };

  function renderSaveStatus(plan) {
    const el = document.getElementById('workoutSaveStatus');
    if (!el) return;
    el.textContent = plan ? 'Saved — 7-day weekly template' : '';
  }

  function handleSave() {
    const textarea = document.getElementById('workoutPlanInput');
    const raw = textarea.value.trim();
    if (!raw) {
      UI.toast('Paste a plan before saving.');
      return;
    }
    Storage.savePlan(CATEGORY, raw);
    UI.toast('Workout plan saved');
    render();
  }

  function renderMission() {
    const stats = Storage.getWorkoutStats();
    renderSaveStatus(Storage.getPlan(CATEGORY));

    const dayLabelEl = document.getElementById('workoutTodayDay');
    const missionTextEl = document.getElementById('workoutTodayLabel');
    const detailBodyEl = document.getElementById('workoutDetailBody');
    const actionsEl = document.getElementById('workoutMissionActions');

    if (!stats.hasPlan) {
      dayLabelEl.textContent = '—';
      missionTextEl.textContent = 'Upload a plan to get started.';
      detailBodyEl.innerHTML = '';
      actionsEl.innerHTML = '';
      return;
    }

    const dayName = capitalize(stats.todayDay);
    dayLabelEl.textContent = dayName;

    if (stats.isRestToday) {
      missionTextEl.textContent = `${dayName} — Rest day, nothing scheduled.`;
      detailBodyEl.innerHTML = '';
      actionsEl.innerHTML = '';
      return;
    }

    missionTextEl.textContent = `${dayName} – ${stats.todayLabel}`;
    detailBodyEl.innerHTML = UI.renderWorkoutDetailGroups(stats.todayDetail);

    const task = Storage.getTask(CATEGORY);
    actionsEl.innerHTML = UI.renderActionButtonsHTML(CATEGORY, task.status);
    UI.bindActionButtons(actionsEl, toStatus => {
      Storage.setTaskStatus(CATEGORY, toStatus);
      UI.toast(`Workout → ${UI.STATUS_LABEL[toStatus]}`);
      if (typeof Dashboard !== 'undefined') Dashboard.maybeUpdateStreak();
      render();
    });
  }

  function renderMissedThisWeek(stats) {
    const list = document.getElementById('workoutMissedThisWeekList');
    if (!stats.hasPlan || stats.missedThisWeek.length === 0) {
      list.innerHTML = '<li class="topic-list__empty">Nothing missed yet this week.</li>';
      return;
    }
    list.innerHTML = stats.missedThisWeek.map(m => `
      <li class="topic-list__item">
        ${capitalize(m.day)} — ${m.label}
        <span class="topic-list__week">${MISSED_STATUS_LABEL[m.status] || m.status}</span>
      </li>
    `).join('');
  }

  function renderConsistency() {
    const stats = Storage.getWorkoutStats();
    document.getElementById('workoutConsistencyPct').textContent = `${stats.consistencyPct}%`;
    document.getElementById('workoutConsistencyFill').style.width = `${stats.consistencyPct}%`;
    document.getElementById('workoutCompletedCount').textContent = String(stats.completed);
    document.getElementById('workoutMissedCount').textContent = String(stats.missed);
    document.getElementById('workoutScheduledCount').textContent = String(stats.scheduled);
    renderMissedThisWeek(stats);
  }

  function render() {
    Storage.generateMissionsFor(Storage.todayKey());
    renderMission();
    renderConsistency();
  }

  function init() {
    const saveBtn = document.getElementById('workoutSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', handleSave);

    const plan = Storage.getPlan(CATEGORY);
    const textarea = document.getElementById('workoutPlanInput');
    if (plan && textarea) textarea.value = plan.raw;

    render();
  }

  return { init, render };
})();

/* ===== learningHub.js ===== */
/**
 * learningHub.js
 * ------------------------------------------------------------
 * The Learning Hub is now a real registry-driven page, not two
 * hardcoded tabs. It builds the DOM for every active track (tab +
 * full topic-plan page) at render time, and instantiates
 * PlanEngine.createTopicPlanController — the same factory used
 * since Phase 3 — with generated element ids per track, instead of
 * two hand-authored HTML blocks with hardcoded ids. This is what
 * lets a user-added track ("+ Add Track") get the full plan-upload
 * / mission / progress experience immediately, with no new code.
 *
 * pythonManager.js and englishManager.js no longer exist as
 * separate files — this replaces them entirely. Workout is NOT
 * part of this registry; it stays in workoutManager.js, since its
 * data model (a weekday template) is fundamentally different from
 * a sequential topic track.
 * ------------------------------------------------------------
 */

const LearningHub = (() => {

  let controllers = {}; // trackId -> {init, render}

  function idsFor(trackId) {
    const p = `track-${trackId}`;
    return {
      textareaId: `${p}-input`,
      saveBtnId: `${p}-saveBtn`,
      statusId: `${p}-status`,
      weekHintId: `${p}-weekHint`,
      currentTopicId: `${p}-currentTopic`,
      missionTextId: `${p}-mission`,
      missionActionsId: `${p}-missionActions`,
      progressPctId: `${p}-progressPct`,
      progressFillId: `${p}-progressFill`,
      completedListId: `${p}-completedList`,
      completedCountId: `${p}-completedCount`,
      remainingListId: `${p}-remainingList`,
      remainingCountId: `${p}-remainingCount`
    };
  }

  function trackPageHTML(trackId) {
    const ids = idsFor(trackId);
    return `
      <div class="grid grid--plan-upload">
        <div class="card card--plan-upload">
          <div class="card__head">
            <h2>Upload Plan</h2>
            <span class="card__hint">Paste ChatGPT output</span>
          </div>
          <textarea class="plan-textarea" id="${ids.textareaId}" placeholder="Week 1&#10;Topic One&#10;Topic Two&#10;Topic Three"></textarea>
          <div class="plan-upload__row">
            <button class="action-btn action-btn--primary" id="${ids.saveBtnId}">Save Plan</button>
            <span class="plan-upload__status" id="${ids.statusId}"></span>
          </div>
        </div>
      </div>

      <div class="grid grid--plan-top">
        <div class="card">
          <div class="card__head">
            <h2>Current Topic</h2>
            <span class="card__hint" id="${ids.weekHintId}">—</span>
          </div>
          <p class="current-topic__value" id="${ids.currentTopicId}">Upload a plan to get started.</p>
        </div>

        <div class="card">
          <div class="card__head">
            <h2>Today's Mission</h2>
            <span class="card__hint">Adaptive</span>
          </div>
          <p class="mission__text" id="${ids.missionTextId}">—</p>
          <div class="planner-card__actions" id="${ids.missionActionsId}"></div>
        </div>
      </div>

      <div class="grid grid--plan-mid">
        <div class="card">
          <div class="card__head">
            <h2>Progress</h2>
            <span class="card__hint" id="${ids.progressPctId}">0%</span>
          </div>
          <div class="progress-bar"><div class="progress-bar__fill" id="${ids.progressFillId}" style="width:0%"></div></div>
        </div>
      </div>

      <div class="grid grid--plan-bottom">
        <div class="card">
          <div class="card__head">
            <h2>Completed Topics</h2>
            <span class="card__hint" id="${ids.completedCountId}">0</span>
          </div>
          <ul class="topic-list" id="${ids.completedListId}">
            <li class="topic-list__empty">Nothing completed yet.</li>
          </ul>
        </div>

        <div class="card">
          <div class="card__head">
            <h2>Remaining Topics</h2>
            <span class="card__hint" id="${ids.remainingCountId}">0</span>
          </div>
          <ul class="topic-list" id="${ids.remainingListId}">
            <li class="topic-list__empty">Upload a plan to see topics.</li>
          </ul>
        </div>
      </div>
    `;
  }

  function activate(trackId) {
    document.querySelectorAll('.learning-tab[data-track]').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.track === trackId);
    });
    document.querySelectorAll('.learning-track').forEach(section => {
      section.classList.toggle('is-active', section.dataset.track === trackId);
    });
    if (controllers[trackId]) controllers[trackId].render();
  }

  function bindTabs() {
    document.querySelectorAll('.learning-tab[data-track]').forEach(btn => {
      btn.addEventListener('click', () => activate(btn.dataset.track));
    });
  }

  function bindAddTrackControls() {
    const openBtn = document.getElementById('learningAddTrackBtn');
    const form = document.getElementById('addTrackForm');
    const input = document.getElementById('addTrackInput');
    const confirmBtn = document.getElementById('addTrackConfirmBtn');
    const cancelBtn = document.getElementById('addTrackCancelBtn');

    openBtn.addEventListener('click', () => {
      form.style.display = 'flex';
      input.value = '';
      input.focus();
    });

    cancelBtn.addEventListener('click', () => {
      form.style.display = 'none';
    });

    const submit = () => {
      const id = Storage.addTrack(input.value);
      if (!id) {
        UI.toast('Give the track a name first.');
        return;
      }
      UI.refreshTaskRegistry();
      form.style.display = 'none';
      buildAndRenderHub();
      activate(id);
      UI.toast('Track added');
    };
    confirmBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  }

  /** Rebuilds every tab and track page from the current registry,
   *  and (re)creates a controller per track. Called on init and any
   *  time the registry changes (add/archive/restore a track). */
  function buildAndRenderHub() {
    const tracks = Storage.getTracks();
    const tabsEl = document.getElementById('learningTabs');
    const containerEl = document.getElementById('learningTracksContainer');

    const previouslyActive = document.querySelector('.learning-tab.is-active[data-track]');
    const activeId = previouslyActive ? previouslyActive.dataset.track : (tracks[0] ? tracks[0].id : null);

    tabsEl.innerHTML = tracks.map((t, i) => `
      <button class="learning-tab ${t.id === activeId ? 'is-active' : ''}" data-track="${t.id}">${t.icon || '◆'} ${t.label}</button>
    `).join('') + `<button class="learning-tab learning-tab--add" id="learningAddTrackBtn" title="Add a track">+ Add</button>`;

    if (tracks.length === 0) {
      containerEl.innerHTML = `
        <div class="placeholder-card">
          <span class="placeholder-card__icon">⧉</span>
          <h2>No learning tracks yet</h2>
          <p>Tap "+ Add" above to create your first one — Python, English, or anything you're studying.</p>
        </div>
      `;
    } else {
      containerEl.innerHTML = tracks.map(t => `
        <div class="learning-track ${t.id === activeId ? 'is-active' : ''}" data-track="${t.id}" id="track-${t.id}"></div>
      `).join('');
    }

    controllers = {};
    tracks.forEach(t => {
      const section = document.getElementById(`track-${t.id}`);
      section.innerHTML = trackPageHTML(t.id);
      controllers[t.id] = PlanEngine.createTopicPlanController(t.id, idsFor(t.id));
      controllers[t.id].init();
    });

    bindTabs();
    bindAddTrackControls();
  }

  function render() {
    const activeTab = document.querySelector('.learning-tab.is-active[data-track]');
    if (activeTab && controllers[activeTab.dataset.track]) {
      controllers[activeTab.dataset.track].render();
    }
  }

  function init() {
    UI.refreshTaskRegistry();
    buildAndRenderHub();
  }

  return { init, render, refresh: buildAndRenderHub };
})();

/* ===== recoveryPlanner.js ===== */
/**
 * recoveryPlanner.js
 * ------------------------------------------------------------
 * Recovery Planner — the core feature's front door. Collects Work
 * End Time + Energy Level (+ the optional "Recover Workout"
 * opt-in), hands them to Storage.generateRecoveryPlan (which runs
 * RecoveryEngine and saves the result), then renders whatever comes
 * back. Needs no changes for the track registry — every active
 * learning track is automatically a candidate, since that list is
 * computed inside storage.js from the live registry.
 * ------------------------------------------------------------
 */

const RecoveryPlanner = (() => {

  const REASON_OPTIONS = [
    { value: 'work', label: 'Work' },
    { value: 'low_energy', label: 'Low Energy' },
    { value: 'unexpected_event', label: 'Unexpected Event' },
    { value: 'lack_of_focus', label: 'Lack of Focus' },
    { value: 'other', label: 'Other' }
  ];

  function currentEnergySelection() {
    const active = document.querySelector('.energy-btn.is-active');
    return active ? active.dataset.energy : 'medium';
  }

  function setEnergySelection(level) {
    document.querySelectorAll('.energy-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.energy === level);
    });
  }

  function bindInputs() {
    document.querySelectorAll('.energy-btn').forEach(btn => {
      btn.addEventListener('click', () => setEnergySelection(btn.dataset.energy));
    });

    document.getElementById('recoveryGenerateBtn').addEventListener('click', handleGenerate);
    document.getElementById('reviewSubmitBtn').addEventListener('click', handleReviewSubmit);
  }

  function handleGenerate() {
    const workEndInput = document.getElementById('recoveryWorkEndInput');
    const workEndTime = workEndInput.value;
    if (!workEndTime) {
      UI.toast('Pick a work end time first.');
      return;
    }

    const energyLevel = currentEnergySelection();
    const includeWorkoutRecovery = document.getElementById('recoverWorkoutToggle').checked;

    const session = Storage.generateRecoveryPlan({ workEndTime, energyLevel, includeWorkoutRecovery });
    if (session) {
      UI.toast('Recovery plan generated');
      if (typeof Dashboard !== 'undefined') Dashboard.maybeUpdateStreak();
    }
    render();
  }

  function renderAvailableTime(session) {
    const el = document.getElementById('recoveryAvailableSummary');
    if (!session) {
      el.textContent = 'Enter your work end time and generate a plan to see available recovery time.';
      return;
    }
    const { dinnerStart, dinnerEnd, recoveryStart, recoveryEnd, cappedMinutes, availableMinutes } = session.availableTime;
    const cappedNote = cappedMinutes < availableMinutes
      ? ` (capped from ${availableMinutes}m by the 90-minute recovery limit)`
      : '';
    el.innerHTML = `
      Dinner: <strong>${UI.minutesToClockLabel(dinnerStart)}–${UI.minutesToClockLabel(dinnerEnd)}</strong><br>
      Recovery window: <strong>${UI.minutesToClockLabel(recoveryStart)}–${UI.minutesToClockLabel(recoveryEnd)}</strong><br>
      Available: <strong>${cappedMinutes} min</strong>${cappedNote}
    `;
  }

  function renderSchedule(session) {
    const list = document.getElementById('recoveryScheduleList');
    list.innerHTML = '';

    if (!session || session.scheduled.length === 0) {
      list.innerHTML = `<li class="topic-list__empty">${session ? 'Nothing needed recovery tonight.' : 'Generate a plan to see tonight\u2019s schedule.'}</li>`;
      return;
    }

    session.scheduled.forEach(item => {
      const task = Storage.getTask(item.category);
      const meta = UI.TASK_META[item.category] || { icon: '◆', label: item.category };
      const row = UI.el('li', 'recovery-schedule__row', `
        <div class="recovery-schedule__info">
          <span class="recovery-schedule__time">${UI.minutesToClockLabel(item.startMinutes)}</span>
          <span class="recovery-schedule__name">${meta.icon} ${meta.label} Recovery</span>
          <span class="recovery-schedule__mode">${item.mode} · ${item.minutes}m</span>
        </div>
        <span class="planner-card__status">${UI.STATUS_LABEL[task.status]}</span>
        <div class="planner-card__actions" data-actions-for="${item.category}"></div>
      `);
      list.appendChild(row);

      const actionsEl = row.querySelector('[data-actions-for]');
      actionsEl.innerHTML = UI.renderActionButtonsHTML(item.category, task.status);
      UI.bindActionButtons(actionsEl, toStatus => {
        Storage.setTaskStatus(item.category, toStatus);
        UI.toast(`${meta.label} → ${UI.STATUS_LABEL[toStatus]}`);
        if (typeof Dashboard !== 'undefined') Dashboard.maybeUpdateStreak();
        render();
      });
    });
  }

  function renderDeferredAndWorkout(session) {
    const list = document.getElementById('recoveryDeferredList');
    const workoutNote = document.getElementById('recoveryWorkoutNote');
    list.innerHTML = '';

    if (!session) {
      list.innerHTML = '<li class="topic-list__empty">Nothing deferred yet.</li>';
      workoutNote.textContent = '';
      return;
    }

    if (session.deferred.length === 0) {
      list.innerHTML = '<li class="topic-list__empty">Nothing deferred tonight.</li>';
    } else {
      session.deferred.forEach(category => {
        const meta = UI.TASK_META[category] || { icon: '◆', label: category };
        list.appendChild(UI.el('li', 'topic-list__item is-deferred-item', `
          ${meta.icon} ${meta.label} <span class="topic-list__week">Deferred to tomorrow</span>
        `));
      });
    }

    workoutNote.textContent = session.workoutNeedsResume
      ? 'Workout wasn\u2019t recovered tonight — it stays on Resume Tomorrow. Check "Recover Workout" above and regenerate if you want to fit it in instead.'
      : '';
  }

  function renderRealityScore() {
    const scoreInfo = Storage.getRealityScore();
    document.getElementById('recoveryScoreValue').textContent = scoreInfo.score;
    document.getElementById('recoveryScoreLabel').textContent = scoreInfo.label;
    document.getElementById('recoveryScoreRing').style.setProperty('--pct', scoreInfo.score);
  }

  function renderTrend() {
    const analytics = Storage.getRecoveryAnalytics(7);
    const chart = document.getElementById('recoveryTrendChart');
    chart.innerHTML = '';

    analytics.weeklyTrend.forEach((day, i) => {
      const d = new Date(day.date + 'T00:00:00');
      const label = d.toLocaleDateString('en-US', { weekday: 'narrow' });
      const pct = day.score || 0;
      const col = UI.el('div', `bar-chart__col ${i === analytics.weeklyTrend.length - 1 ? 'is-today' : ''}`, `
        <div class="bar-chart__track"><div class="bar-chart__fill" style="height:${pct}%"></div></div>
        <span class="bar-chart__label">${label}</span>
      `);
      chart.appendChild(col);
    });

    const rateText = analytics.recoverySuccessRatePct === null ? '—' : `${analytics.recoverySuccessRatePct}%`;
    document.getElementById('recoverySuccessRate').textContent = rateText;
    document.getElementById('recoverySessionsCount').textContent = String(analytics.recoverySessionsCount);
    document.getElementById('recoveryDeferredTotal').textContent = String(analytics.deferredTasksCount);
  }

  function renderReview() {
    const todayTasks = Storage.ensureTodayTasks();
    const existingReview = Storage.getEndOfDayReview();

    const completed = UI.TASK_ORDER.filter(k => todayTasks[k] && todayTasks[k].status === 'completed');
    const missed = UI.TASK_ORDER.filter(k => todayTasks[k] && todayTasks[k].status !== 'completed');

    document.getElementById('reviewCompletedList').innerHTML = completed.length
      ? completed.map(k => `<li class="topic-list__item is-done">${UI.TASK_META[k].icon} ${UI.TASK_META[k].label}</li>`).join('')
      : '<li class="topic-list__empty">Nothing completed yet today.</li>';

    const reasonsContainer = document.getElementById('reviewReasonsList');
    reasonsContainer.innerHTML = '';

    if (missed.length === 0) {
      reasonsContainer.innerHTML = '<p class="recovery-suggestion__text">Everything was completed today — nothing to review.</p>';
    } else {
      missed.forEach(k => {
        const meta = UI.TASK_META[k];
        const savedReason = existingReview && existingReview.reasons ? existingReview.reasons[k] : '';
        const row = UI.el('div', 'review-row', `
          <span class="review-row__label">${meta.icon} ${meta.label}</span>
          <select class="review-row__select" data-category="${k}">
            <option value="">Why was it missed?</option>
            ${REASON_OPTIONS.map(opt => `<option value="${opt.value}" ${savedReason === opt.value ? 'selected' : ''}>${opt.label}</option>`).join('')}
          </select>
        `);
        reasonsContainer.appendChild(row);
      });
    }

    const statusEl = document.getElementById('reviewSubmitStatus');
    statusEl.textContent = existingReview ? `Submitted ${new Date(existingReview.submittedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';
  }

  function handleReviewSubmit() {
    const reasons = {};
    document.querySelectorAll('.review-row__select').forEach(select => {
      if (select.value) reasons[select.dataset.category] = select.value;
    });
    Storage.submitEndOfDayReview(reasons);
    UI.toast('Review saved');
    render();
  }

  function render() {
    Storage.generateMissionsFor(Storage.todayKey());
    const session = Storage.getRecoverySession();

    if (session) {
      const workEndInput = document.getElementById('recoveryWorkEndInput');
      if (!workEndInput.value) workEndInput.value = session.workEndTime;
      setEnergySelection(session.energyLevel);
      document.getElementById('recoverWorkoutToggle').checked = session.includeWorkoutRecovery;
    }

    renderAvailableTime(session);
    renderSchedule(session);
    renderDeferredAndWorkout(session);
    renderRealityScore();
    renderTrend();
    renderReview();
  }

  function init() {
    setEnergySelection('medium');
    bindInputs();
    render();
  }

  return { init, render };
})();

/* ===== analytics.js ===== */
/**
 * analytics.js
 * ------------------------------------------------------------
 * The Insights page. Every insight is read from data the app
 * already collects elsewhere — nothing new is stored just to
 * support this page. Learning-related sentences (velocity, peak
 * productivity window) now loop over every active track in the
 * registry instead of hardcoding 'python'/'english', so a
 * user-added track gets the same insights automatically.
 * ------------------------------------------------------------
 */

const Analytics = (() => {

  const REASON_LABELS = {
    work: 'Work',
    low_energy: 'Low Energy',
    unexpected_event: 'an Unexpected Event',
    lack_of_focus: 'Lack of Focus',
    other: 'something else'
  };

  function renderTrend() {
    const analytics = Storage.getRecoveryAnalytics(7);
    const chart = document.getElementById('insightsTrendChart');
    chart.innerHTML = '';

    analytics.weeklyTrend.forEach((day, i) => {
      const d = new Date(day.date + 'T00:00:00');
      const label = d.toLocaleDateString('en-US', { weekday: 'narrow' });
      const pct = day.score || 0;
      const col = UI.el('div', `bar-chart__col ${i === analytics.weeklyTrend.length - 1 ? 'is-today' : ''}`, `
        <div class="bar-chart__track"><div class="bar-chart__fill" style="height:${pct}%"></div></div>
        <span class="bar-chart__label">${label}</span>
      `);
      chart.appendChild(col);
    });

    document.getElementById('insightsSuccessRate').textContent =
      analytics.recoverySuccessRatePct === null ? '—' : `${analytics.recoverySuccessRatePct}%`;
    document.getElementById('insightsSessionsCount').textContent = String(analytics.recoverySessionsCount);
    document.getElementById('insightsDeferredTotal').textContent = String(analytics.deferredTasksCount);

    return analytics;
  }

  function consistencyTrendSentence() {
    const state = Storage.getState();
    const pctForWindow = (start, end) => {
      let total = 0, count = 0;
      for (let i = start; i < end; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const entry = state.history[Storage.todayKey(d)];
        if (entry && typeof entry.completedPct === 'number') { total += entry.completedPct; count += 1; }
      }
      return count === 0 ? null : Math.round(total / count);
    };

    const recent = pctForWindow(0, 7);
    const earlier = pctForWindow(14, 21);
    if (recent === null) return null;

    if (earlier === null) {
      return `Your completion rate has averaged <strong>${recent}%</strong> over the last 7 days.`;
    }
    if (recent > earlier) {
      return `Your completion rate has climbed from <strong>${earlier}%</strong> to <strong>${recent}%</strong> over the last three weeks.`;
    }
    if (recent < earlier) {
      return `Your completion rate has dipped from <strong>${earlier}%</strong> to <strong>${recent}%</strong> over the last three weeks.`;
    }
    return `Your completion rate has held steady around <strong>${recent}%</strong> over the last three weeks.`;
  }

  function recoverySuccessSentence(analytics) {
    if (analytics.recoverySuccessRatePct === null) {
      return `No recovery data yet — generate a Recovery Plan once something slips to start tracking this.`;
    }
    return `You recover <strong>${analytics.recoverySuccessRatePct}%</strong> of tasks that get scheduled into an evening plan.`;
  }

  function learningVelocitySentence(trackId, label) {
    const v = Storage.getLearningVelocity(trackId);
    if (!v) return null;
    if (v.remaining === 0) {
      return `You've finished every topic in your ${label} plan. 🎉`;
    }
    if (v.perActiveDay === 0) {
      return `Your ${label} plan has <strong>${v.remaining}</strong> topics left — no completions in the last 30 days yet.`;
    }
    const pace = v.projectedDays
      ? ` at this pace, your plan finishes in about <strong>${v.projectedDays} day${v.projectedDays === 1 ? '' : 's'}</strong>.`
      : '';
    return `You're completing about <strong>${v.perActiveDay}</strong> ${label} topic${v.perActiveDay === 1 ? '' : 's'} per active day —${pace}`;
  }

  function peakWindowSentence(trackId, label) {
    const w = Storage.getPeakProductivityWindow(trackId);
    if (!w || w.total < 3) return null;
    if (w.before7pmPct >= 60) {
      return `You complete ${label} <strong>${w.before7pmPct}%</strong> of the time before 7 PM — mornings/afternoons are your strongest window for it.`;
    }
    if (w.after9pmPct >= 40) {
      return `<strong>${w.after9pmPct}%</strong> of your ${label} completions happen after 9 PM — it's become a late-evening habit.`;
    }
    return null;
  }

  function workoutAdherenceSentence() {
    const stats = Storage.getWorkoutStats();
    if (!stats.hasPlan || stats.scheduled === 0) return null;
    return `You've completed <strong>${stats.completed} of ${stats.scheduled}</strong> scheduled workout sessions this week (${stats.consistencyPct}% consistency).`;
  }

  function missedCausesSentence() {
    const causes = Storage.getMissedTaskCauses(60);
    const entries = Object.entries(causes);
    if (entries.length === 0) return null;

    entries.sort((a, b) => b[1].total - a[1].total);
    const [category, info] = entries[0];
    const label = UI.TASK_META[category] ? UI.TASK_META[category].label : category;
    const reasonLabel = REASON_LABELS[info.topReason] || info.topReason;
    return `${reasonLabel} is behind <strong>${info.pct}%</strong> of your missed ${label} tasks over the last two months.`;
  }

  function renderSentences(analytics) {
    const list = document.getElementById('insightSentences');
    const tracks = Storage.getTracks();

    const sentences = [
      consistencyTrendSentence(),
      recoverySuccessSentence(analytics),
      ...tracks.map(t => learningVelocitySentence(t.id, t.label)),
      workoutAdherenceSentence(),
      ...tracks.map(t => peakWindowSentence(t.id, t.label)).filter(Boolean).slice(0, 1),
      missedCausesSentence()
    ].filter(Boolean);

    if (sentences.length === 0) {
      list.innerHTML = `<li class="insight-list__empty">Come back in a few days — insights need a bit of real use to say anything true.</li>`;
      return;
    }

    list.innerHTML = sentences.map(s => `<li class="insight-list__item">${s}</li>`).join('');
  }

  function render() {
    const analytics = renderTrend();
    renderSentences(analytics);
  }

  function init() {
    render();
  }

  return { init, render };
})();

/* ===== today.js ===== */
/**
 * today.js
 * ------------------------------------------------------------
 * The three pieces of the merged "Today" view that didn't exist as
 * Dashboard or Planner concepts before:
 *
 *   - Hero card: "what's next" — the single most useful thing to
 *     act on right now, with its own Start/Defer/Skip/Complete
 *     buttons. Iterates UI.TASK_ORDER, so it automatically includes
 *     any user-added learning track.
 *   - Onboarding checklist: 4 steps, auto-detected from existing
 *     Storage state, hidden entirely once all 4 are done.
 *   - Recovery Prompt: a conditional banner that only appears once
 *     there's something worth recovering.
 * ------------------------------------------------------------
 */

const Today = (() => {

  function nextActionableTask() {
    const todayTasks = Storage.ensureTodayTasks();
    return UI.TASK_ORDER.find(k => {
      const status = todayTasks[k] && todayTasks[k].status;
      return status && status !== 'completed' && status !== 'skipped';
    }) || null;
  }

  function missionLine(key) {
    const task = Storage.getTask(key);
    if (!Storage.hasPlan(key)) return `Mode: ${task.mode}`;
    const mission = Storage.getMission(key);
    if (!mission) return `Mode: ${task.mode}`;
    if (mission.type === 'workout') {
      if (mission.isRest) return 'Rest day';
      const dayName = mission.day ? mission.day.charAt(0).toUpperCase() + mission.day.slice(1) : '';
      return dayName ? `${dayName} – ${mission.label}` : mission.label;
    }
    return mission.isComplete ? 'Plan complete 🎉' : mission.topic;
  }

  function renderHero() {
    const hintEl = document.getElementById('heroCardHint');
    const bodyEl = document.getElementById('heroCardBody');
    const key = nextActionableTask();

    if (!key) {
      hintEl.textContent = 'All caught up';
      bodyEl.innerHTML = `<p class="hero-card__done">Every task is handled for today. Nice work.</p>`;
      return;
    }

    const meta = UI.TASK_META[key];
    const task = Storage.getTask(key);
    hintEl.textContent = UI.STATUS_LABEL[task.status];

    // Workout missions get a tap-to-expand exercise breakdown,
    // identical to the one on the Fitness page — everything else
    // just shows its mission line as text.
    let missionHtml;
    if (key === 'workout' && Storage.hasPlan('workout')) {
      const mission = Storage.getMission(key);
      const groups = (mission && mission.detail) ? mission.detail : [];
      missionHtml = `
        <details class="workout-detail hero-card__workout-detail">
          <summary class="workout-detail__summary">
            <span>${missionLine(key)}</span>
            <span class="workout-detail__chevron">▾</span>
          </summary>
          <div class="workout-detail__body">${UI.renderWorkoutDetailGroups(groups)}</div>
        </details>
      `;
    } else {
      missionHtml = `<p class="hero-card__mission">${missionLine(key)}</p>`;
    }

    bodyEl.innerHTML = `
      <div class="hero-card__task">
        <span class="hero-card__icon">${meta.icon}</span>
        <div class="hero-card__task-body">
          <p class="hero-card__name">${meta.label}</p>
          ${missionHtml}
        </div>
      </div>
      <div class="planner-card__actions" id="heroCardActions"></div>
    `;

    const actionsEl = document.getElementById('heroCardActions');
    actionsEl.innerHTML = UI.renderActionButtonsHTML(key, task.status);
    UI.bindActionButtons(actionsEl, toStatus => {
      Storage.setTaskStatus(key, toStatus);
      UI.toast(`${meta.label} → ${UI.STATUS_LABEL[toStatus]}`);
      Dashboard.maybeUpdateStreak();
      renderAll();
      if (typeof Planner !== 'undefined') Planner.render();
      if (typeof Dashboard !== 'undefined') Dashboard.render();
    });
  }

  function hasEverCompletedATask(daysBack = 90) {
    const state = Storage.getState();
    for (let i = 0; i < daysBack; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dTasks = state.tasks[Storage.todayKey(d)];
      if (dTasks && UI.TASK_ORDER.some(k => dTasks[k] && dTasks[k].status === 'completed')) return true;
    }
    return false;
  }

  function hasEverGeneratedRecoveryPlan() {
    const state = Storage.getState();
    return Object.keys(state.recoverySessions || {}).length > 0;
  }

  function hasAnyLearningPlan() {
    return Storage.getTracks().some(t => Storage.hasPlan(t.id));
  }

  function renderOnboarding() {
    const card = document.getElementById('onboardingChecklist');
    const list = document.getElementById('onboardingList');

    const steps = [
      { label: 'Upload your first learning plan', done: hasAnyLearningPlan(), view: 'learning' },
      { label: 'Upload a workout plan', done: Storage.hasPlan('workout'), view: 'fitness' },
      { label: 'Complete your first task', done: hasEverCompletedATask(), view: 'today' },
      { label: 'Generate your first recovery plan', done: hasEverGeneratedRecoveryPlan(), view: 'recovery' }
    ];

    if (steps.every(s => s.done)) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';
    list.innerHTML = steps.map(s => `
      <li class="onboarding-item ${s.done ? 'is-done' : ''}" data-view="${s.view}">
        <span class="onboarding-item__check">${s.done ? '✓' : '○'}</span>
        <span class="onboarding-item__label">${s.label}</span>
      </li>
    `).join('');

    list.querySelectorAll('.onboarding-item').forEach(item => {
      item.addEventListener('click', () => {
        if (typeof App !== 'undefined') App.setActiveView(item.dataset.view);
      });
    });
  }

  function renderRecoveryPrompt() {
    const banner = document.getElementById('recoveryPromptBanner');
    const titleEl = document.getElementById('recoveryPromptTitle');
    const subEl = document.getElementById('recoveryPromptSub');

    const todayTasks = Storage.ensureTodayTasks();
    const pendingCount = UI.TASK_ORDER.filter(k => {
      const status = todayTasks[k] && todayTasks[k].status;
      return status && status !== 'completed' && status !== 'skipped';
    }).length;
    const hasDeferred = UI.TASK_ORDER.some(k => todayTasks[k] && todayTasks[k].status === 'deferred');
    const hourNow = new Date().getHours();
    const isEvening = hourNow >= 18;

    const shouldShow = pendingCount > 0 && (isEvening || hasDeferred);

    if (!shouldShow) {
      banner.style.display = 'none';
      return;
    }

    banner.style.display = 'flex';
    titleEl.textContent = hasDeferred ? 'Something got deferred' : 'Work day winding down?';
    subEl.textContent = `${pendingCount} task${pendingCount === 1 ? '' : 's'} still open — Recovery can build you a realistic evening.`;
  }

  function bindRecoveryPromptButton() {
    document.getElementById('recoveryPromptBtn').addEventListener('click', () => {
      if (typeof App !== 'undefined') App.setActiveView('recovery');
    });
  }

  function renderAll() {
    renderHero();
    renderOnboarding();
    renderRecoveryPrompt();
  }

  function init() {
    bindRecoveryPromptButton();
    renderAll();
  }

  return { init, render: renderAll };
})();

/* ===== settings.js ===== */
/**
 * settings.js
 * ------------------------------------------------------------
 * Export/Import, PIN management, the local lock/reset actions, and
 * (new) Manage Tracks — archiving/restoring learning tracks from
 * the registry. Archiving hides a track from Learning/Recovery/
 * Insights without deleting its plan or history, in case it's
 * wanted back later.
 * ------------------------------------------------------------
 */

const Settings = (() => {

  function handleExport() {
    const json = Storage.exportDataAsJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = Storage.todayKey();
    a.href = url;
    a.download = `adaptive-os-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    document.getElementById('settingsDataStatus').textContent = 'Backup downloaded.';
  }

  function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    const statusEl = document.getElementById('settingsDataStatus');
    if (!file) return;

    const confirmed = confirm('Importing a backup replaces everything currently on this device. Continue?');
    if (!confirmed) { e.target.value = ''; return; }

    const reader = new FileReader();
    reader.onload = () => {
      const result = Storage.importDataFromJSON(reader.result);
      if (result.ok) {
        statusEl.textContent = 'Backup restored — reloading...';
        setTimeout(() => location.reload(), 800);
      } else {
        statusEl.textContent = result.error;
      }
    };
    reader.onerror = () => { statusEl.textContent = 'Could not read that file.'; };
    reader.readAsText(file);
    e.target.value = '';
  }

  function handleChangePin() {
    const oldPin = document.getElementById('settingsCurrentPin').value;
    const newPin = document.getElementById('settingsNewPin').value;
    const errorEl = document.getElementById('settingsPinError');

    if (!/^\d{4,6}$/.test(newPin)) {
      errorEl.textContent = 'New PIN must be 4–6 digits.';
      return;
    }
    if (Auth.changePin(oldPin, newPin)) {
      errorEl.textContent = '';
      document.getElementById('settingsCurrentPin').value = '';
      document.getElementById('settingsNewPin').value = '';
      UI.toast('PIN updated');
    } else {
      errorEl.textContent = 'Current PIN is incorrect.';
    }
  }

  async function handleForceRefresh() {
    const statusEl = document.getElementById('settingsDataStatus');
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(reg => reg.unregister()));
    }
    statusEl.textContent = 'Cache cleared — reloading with the latest files...';
    setTimeout(() => location.reload(), 600);
  }

  async function handleReset() {
    const confirmed = confirm(
      'This erases everything on this device — plans, tasks, streaks, history, your PIN. ' +
      'Download a backup first if you want to keep anything. Continue?'
    );
    if (!confirmed) return;

    localStorage.clear();
    sessionStorage.clear();

    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(reg => reg.unregister()));
    }

    location.reload();
  }

  function renderTrackList() {
    const list = document.getElementById('settingsTrackList');
    if (!list) return;
    const active = Storage.getTracks();
    const archived = Storage.getTracks(true).filter(t => t.archived);

    if (active.length === 0 && archived.length === 0) {
      list.innerHTML = '<li class="topic-list__empty">No tracks yet — add one from the Learning page.</li>';
      return;
    }

    const activeRows = active.map(t => `
      <li class="track-manage-row" data-track="${t.id}" data-action="archive">
        <span>${t.icon || '◆'} ${t.label}</span>
        <button class="action-btn action-btn--ghost track-manage-btn" data-track="${t.id}" data-action="archive">Archive</button>
      </li>
    `).join('');

    const archivedRows = archived.map(t => `
      <li class="track-manage-row is-archived" data-track="${t.id}">
        <span>${t.icon || '◆'} ${t.label} <span class="topic-list__week">Archived</span></span>
        <button class="action-btn action-btn--ghost track-manage-btn" data-track="${t.id}" data-action="restore">Restore</button>
      </li>
    `).join('');

    list.innerHTML = activeRows + archivedRows;

    list.querySelectorAll('.track-manage-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const trackId = btn.dataset.track;
        if (btn.dataset.action === 'archive') {
          Storage.archiveTrack(trackId);
          UI.toast('Track archived');
        } else {
          Storage.restoreTrack(trackId);
          UI.toast('Track restored');
        }
        UI.refreshTaskRegistry();
        if (typeof LearningHub !== 'undefined') LearningHub.refresh();
        renderTrackList();
      });
    });
  }

  function bind() {
    document.getElementById('settingsExportBtn').addEventListener('click', handleExport);
    document.getElementById('settingsImportInput').addEventListener('change', handleImportFile);
    document.getElementById('settingsChangePinBtn').addEventListener('click', handleChangePin);
    document.getElementById('settingsLockBtn').addEventListener('click', () => Auth.lockNow());
    document.getElementById('settingsForceRefreshBtn').addEventListener('click', handleForceRefresh);
    document.getElementById('settingsResetBtn').addEventListener('click', handleReset);
  }

  function render() {
    document.getElementById('settingsDataStatus').textContent = '';
    document.getElementById('settingsPinError').textContent = '';
    renderTrackList();
  }

  function init() {
    bind();
    render();
  }

  return { init, render };
})();

/* ===== app.js ===== */
/**
 * app.js
 * ------------------------------------------------------------
 * App bootstrap + view router. Views are simple show/hide
 * sections inside index.html (no page reloads).
 *
 * Nav destinations: Today / Learning / Fitness / Recovery /
 * Insights / Settings. Learning is now driven entirely by
 * LearningHub + the track registry — there's no PythonManager or
 * EnglishManager to initialize separately anymore.
 * ------------------------------------------------------------
 */

const App = (() => {

  const VIEW_TITLES = {
    today: { title: 'Today', subtitle: "What's next, and how the day's actually going." },
    learning: { title: 'Learning', subtitle: 'Upload plans, track missions, watch progress move.' },
    fitness: { title: 'Fitness', subtitle: 'Upload plans, track consistency.' },
    recovery: { title: 'Recovery', subtitle: 'Reorganize the evening around reality.' },
    insights: { title: 'Insights', subtitle: 'What the app has noticed about you.' },
    settings: { title: 'Settings', subtitle: 'Your data, your PIN, your device.' }
  };

  function setActiveView(viewName) {
    document.querySelectorAll('.nav__item').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.view === viewName);
    });
    document.querySelectorAll('.view').forEach(section => {
      section.classList.toggle('is-active', section.dataset.view === viewName);
    });

    const copy = VIEW_TITLES[viewName];
    if (copy) {
      document.getElementById('viewTitle').textContent = copy.title;
      document.getElementById('viewSubtitle').textContent = copy.subtitle;
    }

    if (viewName === 'today') { Dashboard.render(); Planner.render(); Today.render(); }
    if (viewName === 'learning') LearningHub.render();
    if (viewName === 'fitness') WorkoutManager.render();
    if (viewName === 'recovery') RecoveryPlanner.render();
    if (viewName === 'insights') Analytics.render();
    if (viewName === 'settings') Settings.render();
    location.hash = viewName;
  }

  function bindNav() {
    document.querySelectorAll('.nav__item').forEach(btn => {
      btn.addEventListener('click', () => setActiveView(btn.dataset.view));
    });
  }

  function initialViewFromHash() {
    const hash = location.hash.replace('#', '');
    return VIEW_TITLES[hash] ? hash : 'today';
  }

  function init() {
    Storage.init();
    Auth.init();
    UI.refreshTaskRegistry();
    bindNav();

    Dashboard.init();
    Planner.init();
    WorkoutManager.init();
    LearningHub.init();
    RecoveryPlanner.init();
    Analytics.init();
    Today.init();
    Settings.init();

    setActiveView(initialViewFromHash());
  }

  return { init, setActiveView };
})();

document.addEventListener('DOMContentLoaded', App.init);

/**
 * Service worker registration for PWA installability. Only
 * succeeds over HTTPS or http://localhost — browsers refuse it on
 * file://, by design. Guarded so opening a single HTML file
 * directly still works exactly as before.
 */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
