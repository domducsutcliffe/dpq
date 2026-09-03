// ── Crypto gate ──────────────────────────────────────────────────────────────
// Data files are AES-256-GCM encrypted at build time.  The password is used to
// derive the decryption key via PBKDF2.  No password or hash is stored in this
// source — a wrong password simply fails to decrypt the data.
const PBKDF2_ITERATIONS = 100_000;

function b64toBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function decryptPayload(envelope, password) {
  const { salt, iv, tag, data } = envelope;
  const saltBytes = b64toBytes(salt);
  const ivBytes = b64toBytes(iv);
  const tagBytes = b64toBytes(tag);
  const cipherBytes = b64toBytes(data);

  // AES-GCM expects ciphertext + authTag concatenated
  const combined = new Uint8Array(cipherBytes.length + tagBytes.length);
  combined.set(cipherBytes);
  combined.set(tagBytes, cipherBytes.length);

  const key = await deriveKey(password, saltBytes);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, key, combined);
  return new TextDecoder().decode(plainBuf);
}

let _resolvePassword;
// Deliberately `let`, and re-armed after every failed attempt: a `const` promise resolves
// once and keeps handing back the FIRST password forever, so a single typo would lock you
// out of the dashboard until you reloaded the page, however many times you retyped it.
let passwordReady = new Promise((resolve) => { _resolvePassword = resolve; });

function awaitNextPassword() {
  passwordReady = new Promise((resolve) => { _resolvePassword = resolve; });
  return passwordReady;
}

// Build (once) the password overlay and wire its submit. The overlay is opaque and
// position:fixed, so it covers the dashboard on its own — but we ALSO hide `.page`, and
// crucially we do that only AFTER the overlay is safely in the DOM. The old order (hide
// page, then build overlay) meant any hiccup on a cold load left a hidden page with no
// prompt: a blank screen that only a reload fixed. This order cannot do that.
function buildAuthOverlay() {
  if (document.getElementById("auth-overlay")) return;
  const overlay = document.createElement("div");
  overlay.id = "auth-overlay";
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;background:var(--page,#f6f6ef);z-index:9999;display:flex;align-items:center;justify-content:center;">
      <form id="auth-form" style="background:#fff;border:1px solid #d9d4bd;padding:24px 28px;max-width:300px;width:100%;font-family:'Inter',sans-serif;">
        <h2 style="margin:0 0 12px;font-size:14px;font-weight:700;">🔒 Dashboard Access</h2>
        <input id="auth-input" type="password" placeholder="Enter password" autofocus
          style="width:100%;min-height:32px;border:1px solid #d9d4bd;padding:6px 8px;font:inherit;margin-bottom:10px;border-radius:0;">
        <button type="submit" id="auth-btn"
          style="width:100%;min-height:32px;background:#ff6600;border:none;color:#fff;font:inherit;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;font-size:12px;">
          Enter
        </button>
        <p id="auth-error" style="color:#bd2130;font-size:11px;margin:8px 0 0;display:none;">Incorrect password</p>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  const page = document.querySelector(".page");
  if (page) page.style.display = "none";
  document.getElementById("auth-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const val = document.getElementById("auth-input").value;
    document.getElementById("auth-btn").textContent = "Decrypting…";
    document.getElementById("auth-error").style.display = "none";
    _resolvePassword(val);
  });
}

function initAuthGate() {
  try {
    const stored = sessionStorage.getItem("pq-auth-ok");
    if (stored) {
      _resolvePassword(stored);
      return;
    }
    buildAuthOverlay();
  } catch (err) {
    // Never strand the user on a blank page — if the gate fails to initialise, keep the
    // dashboard visible and try once more to raise the prompt.
    console.error("Auth gate init failed:", err);
    const page = document.querySelector(".page");
    if (page) page.style.display = "";
    try {
      buildAuthOverlay();
    } catch (err2) {
      console.error("Auth overlay build failed:", err2);
    }
  }
}

// Modules are deferred, so the DOM is normally ready here — but guard anyway, since the
// gate touching `document.body`/`.page` before they exist is exactly what blanks the page.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAuthGate, { once: true });
} else {
  initAuthGate();
}
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_VERTICAL_ID, getVertical } from "../config.js";

const VERTICAL = getVertical(DEFAULT_VERTICAL_ID);

// Word-boundary, case-insensitive matcher for the vertical's topic roots.
const VERTICAL_MATCH = new RegExp(`\\b(${VERTICAL.matchRoots.join("|")})`, "i");

// Party shown as a coloured square next to the member name (party column removed).
// Emoji squares are a limited palette, so a few minor parties share a colour — the
// full party name is always available on hover via the title attribute.
const PARTY_EMOJI = {
  Lab: "🟥",
  Con: "🟦",
  LD: "🟧",
  SNP: "🟨",
  Green: "🟩",
  DUP: "🟥",
  RUK: "🟦",
  Ind: "⬜",
  SDLP: "🟩",
  PC: "🟩",
  UUP: "🟦",
  Alba: "🟦",
  UKIP: "🟪",
  CUK: "⬛",
  RB: "⬜",
};

function partyEmoji(question) {
  const abbr = question.member.partyAbbreviation || question.member.party || "";
  return PARTY_EMOJI[abbr] || "⬜";
}

const state = {
  questions: [],
  summary: null,
  query: "",
  party: "",
  region: "",
  answer: "",
  periods: ["current"],
  searchQuestionOnly: true,
  chartPoints: [],
  selectedMonth: "",
  selectedTopic: "",
  // Inclusive lower bound on dateTabled, set by the Today / Past three days buttons.
  // "Today" means the most recent day questions were actually tabled, not the calendar
  // date — Parliament doesn't table every day, so a calendar "today" is usually empty.
  tabledSince: "",
};

const PERIODS = {
  current: {
    label: "current Parliament",
    statusLabel: "current Parliament questions shown",
    start: "2024-07-09",
    end: "",
  },
  cameron: {
    label: "Cameron government",
    statusLabel: "Cameron government questions shown",
    start: "2010-05-11",
    end: "2016-07-13",
  },
  may: {
    label: "May government",
    statusLabel: "May government questions shown",
    start: "2016-07-13",
    end: "2019-07-24",
  },
  boris: {
    label: "Boris Johnson government",
    statusLabel: "Boris government questions shown",
    start: "2019-07-24",
    end: "2022-09-06",
  },
  truss: {
    label: "Truss government",
    statusLabel: "Truss government questions shown",
    start: "2022-09-06",
    end: "2022-10-25",
  },
  sunak: {
    label: "Sunak government",
    statusLabel: "Sunak government questions shown",
    start: "2022-10-25",
    end: "2024-07-05",
  },
};

const elements = {
  status: document.querySelector("#data-status"),
  total: document.querySelector("#metric-total"),
  answered: document.querySelector("#metric-answered"),
  latest: document.querySelector("#metric-latest"),
  partyMetric: document.querySelector("#metric-party"),
  regionMetric: document.querySelector("#metric-region"),
  search: document.querySelector("#search"),
  periodCheckboxes: document.querySelectorAll('input[name="period"]'),
  searchQuestionOnly: document.querySelector("#search-question-only"),
  partyFilter: document.querySelector("#party-filter"),
  regionFilter: document.querySelector("#region-filter"),
  answerFilter: document.querySelector("#answer-filter"),
  monthlyRange: document.querySelector("#monthly-range"),
  monthlyChart: document.querySelector("#monthly-chart"),
  partyChart: document.querySelector("#party-chart"),
  regionChart: document.querySelector("#region-chart"),
  themeChart: document.querySelector("#theme-chart"),
  resultsCount: document.querySelector("#results-count"),
  exportButton: document.querySelector("#export-xlsx"),
  table: document.querySelector("#question-table"),
  footer: document.querySelector("#data-footer"),
  tooltip: document.querySelector("#chart-tooltip"),
  answerTooltip: document.querySelector("#answer-tooltip"),
  resetFilters: document.querySelector("#reset-filters"),
  similarPanel: document.querySelector("#similar-panel"),
  filterToday: document.querySelector("#filter-today"),
  filterThreeDays: document.querySelector("#filter-3days"),
};

// Full answer text for the hover tooltip, keyed by question id (populated per render).
const answerByQid = new Map();
// The same, for the rows in the similar-questions panel. Kept separate because
// renderTable clears its map on every render, and the panel outlives a render.
const similarAnswerByQid = new Map();

const formatNumber = new Intl.NumberFormat("en-GB");
const formatDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const MONTH_NAMES = {
  "01": "January",
  "02": "February",
  "03": "March",
  "04": "April",
  "05": "May",
  "06": "June",
  "07": "July",
  "08": "August",
  "09": "September",
  "10": "October",
  "11": "November",
  "12": "December",
};

function parseDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── Similar questions (BETA) ─────────────────────────────────────────────────
// TF-IDF cosine similarity over heading + question text, built lazily in the browser
// over the current Parliament only (~1ms per lookup). Every PQ opens with the same formula
// ("To ask the Secretary of State…"), so that opener is stripped and IDF damps the rest
// of the shared boilerplate — what's left is the distinctive subject matter.
const SIMILAR_STOPWORDS = new Set(
  `a an and any are as at be been being by for from has have how in into is it its of on or that the their
   them there these this those to was were what when where which who why will with would could should make
   made plans plan number many whether if ask asked secretary state department health social care steps
   taking take assessment recent potential impact he she his her they what`.split(/\s+/),
);
const PQ_OPENER = /^to ask the (secretary of state|minister)[^,]*,\s*/i;
const SIMILAR_MIN_SCORE = 0.12;
// Similar questions are drawn from answered PQs in the current Parliament only. A wording
// match against a PQ tabled before the 2024 dissolution is answered by a different
// government under different policy, so it reads as a comparator when it isn't one; and
// an unanswered one has nothing to compare — the answer is the thing you came for.
const SIMILAR_PERIOD = PERIODS.current;
let similarityIndex = null;

function similarityTokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !SIMILAR_STOPWORDS.has(t));
}

function isSimilarCandidate(question) {
  if (!question.answered) return false;
  const date = question.dateTabled || "";
  if (!date || date < SIMILAR_PERIOD.start) return false;
  if (SIMILAR_PERIOD.end && date >= SIMILAR_PERIOD.end) return false;
  return true;
}

function similarityTermFrequencies(question) {
  const body = String(question.questionText || "").replace(PQ_OPENER, "");
  const tf = new Map();
  for (const t of similarityTokens(`${question.heading || ""} ${body}`)) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  return tf;
}

// TF-IDF weights, L2-normalised so a dot product between two vectors is their cosine.
function similarityVector(tf, df, total) {
  const vec = new Map();
  let norm = 0;
  for (const [t, f] of tf) {
    const weight = (1 + Math.log(f)) * Math.log(total / (1 + (df.get(t) || 0)));
    if (weight > 0) {
      vec.set(t, weight);
      norm += weight * weight;
    }
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of vec) vec.set(t, w / norm);
  return vec;
}

function buildSimilarityIndex() {
  const questions = state.questions.filter(isSimilarCandidate);
  const frequencies = questions.map(similarityTermFrequencies);

  const df = new Map();
  for (const tf of frequencies) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);

  const total = frequencies.length;
  const docs = questions.map((q, i) => ({ q, vec: similarityVector(frequencies[i], df, total) }));

  // df and total are kept so a question outside the corpus can still be scored against it.
  similarityIndex = { docs, df, total, byId: new Map(docs.map((d) => [d.q.id, d])) };
}

function findSimilarQuestions(question, limit = 3) {
  if (!similarityIndex) buildSimilarityIndex();
  if (!similarityIndex.total) return [];
  // The anchor question is often the one still waiting for an answer, and may sit outside
  // the current Parliament (the period filter can be widened) — either way it can be
  // absent from the corpus, so score it against that corpus's IDF weights instead.
  const indexed = similarityIndex.byId.get(question.id);
  const targetVec = indexed
    ? indexed.vec
    : similarityVector(
        similarityTermFrequencies(question),
        similarityIndex.df,
        similarityIndex.total,
      );
  const scored = [];
  for (const d of similarityIndex.docs) {
    if (d.q.id === question.id) continue;
    // Walk the smaller vector; both are L2-normalised so the dot product is the cosine.
    const [small, large] = targetVec.size < d.vec.size ? [targetVec, d.vec] : [d.vec, targetVec];
    let score = 0;
    for (const [t, w] of small) {
      const other = large.get(t);
      if (other) score += w * other;
    }
    if (score >= SIMILAR_MIN_SCORE) scored.push({ question: d.q, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Parliament doesn't table questions every day, so "today" is the most recent day that
// actually has questions rather than the calendar date.
function latestTabledDate() {
  return (
    state.summary?.dateRange?.newestTabled ||
    state.questions.reduce((max, q) => ((q.dateTabled || "") > max ? q.dateTabled : max), "")
  );
}

// The three most recent days on which questions were actually tabled — not three
// calendar days. Parliament doesn't sit every day (recess, weekends), so a calendar
// span would often cover only one real tabling day.
function recentRanges() {
  const days = [...new Set(state.questions.map((q) => q.dateTabled).filter(Boolean))].sort().reverse();
  if (!days.length) return null;
  return {
    latest: days[0],
    today: days[0],
    threeDays: days[Math.min(2, days.length - 1)],
    threeDayCount: Math.min(3, days.length),
  };
}

function renderRecentButtons() {
  const r = recentRanges();
  const todayBtn = elements.filterToday;
  const threeBtn = elements.filterThreeDays;
  if (!todayBtn || !threeBtn) return;
  if (!r) {
    todayBtn.hidden = true;
    threeBtn.hidden = true;
    return;
  }

  todayBtn.hidden = false;
  threeBtn.hidden = false;
  todayBtn.textContent = `Last tabling day · ${shortDate(r.today)}`;
  threeBtn.textContent = `Last ${r.threeDayCount} tabling days`;

  const todayActive = state.tabledSince === r.today;
  const threeActive = state.tabledSince === r.threeDays;
  todayBtn.classList.toggle("active", todayActive);
  threeBtn.classList.toggle("active", threeActive);
  todayBtn.setAttribute("aria-pressed", String(todayActive));
  threeBtn.setAttribute("aria-pressed", String(threeActive));
  todayBtn.title = `Questions tabled on ${shortDate(r.today)} — the most recent day on which questions were tabled`;
  threeBtn.title = `Questions from the last ${r.threeDayCount} days on which questions were tabled (${shortDate(r.threeDays)} to ${shortDate(r.latest)})`;
}

function shortDate(value) {
  const date = parseDate(value);
  return date ? formatDate.format(date) : "-";
}

function formatGeneratedAt(isoString) {
  if (!isoString) return "-";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "-";
  const day = date.getDate();
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const monthName = months[date.getMonth()];
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day} ${monthName} @ ${hours}:${minutes}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getQuestionTopic(question) {
  return question.topic || "General";
}

function getTopicCounts(questions) {
  const counts = {};
  for (const q of questions) {
    const topic = getQuestionTopic(q);
    counts[topic] = (counts[topic] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item) || "Unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function questionText(question) {
  return [
    question.uin,
    question.heading,
    question.questionText,
    question.answerText,
    question.member?.name,
    question.member?.party,
    question.member?.partyAbbreviation,
    question.member?.constituency,
    question.region?.nhsRegion,
    question.region?.nation,
  ]
    .join(" ")
    .toLowerCase();
}

function getPeriodInfo() {
  const allKeys = Object.keys(PERIODS);
  const selectedKeys = allKeys.filter(k => state.periods.includes(k));
  
  if (state.periods.includes("all") || selectedKeys.length === 0 || selectedKeys.length === allKeys.length) {
    return {
      statusLabel: "questions from all Parliaments shown",
      label: "all Parliaments",
      dates: `covers all Parliaments from ${shortDate(state.summary?.dateRange?.oldestTabled)} to ${shortDate(state.summary?.dateRange?.newestTabled)}`
    };
  }
  
  const labels = selectedKeys.map(k => PERIODS[k].label);
  let labelText = labels.join(" and ");
  if (labels.length > 2) {
    labelText = labels.slice(0, -1).join(", ") + ", and " + labels.at(-1);
  }
  
  return {
    statusLabel: `questions from selected periods shown`,
    label: labelText,
    dates: `covers selected periods (${labelText})`
  };
}

function getScopedQuestions() {
  const allKeys = Object.keys(PERIODS);
  const selectedKeys = allKeys.filter(k => state.periods.includes(k));
  
  let scoped = state.questions;
  if (!state.periods.includes("all") && selectedKeys.length > 0) {
    scoped = state.questions.filter((question) => {
      return selectedKeys.some((key) => {
        const period = PERIODS[key];
        if (question.dateTabled < period.start) return false;
        if (period.end && question.dateTabled >= period.end) return false;
        return true;
      });
    });
  }

  return scoped.filter((question) => {
    return VERTICAL_MATCH.test(question.heading || "") || VERTICAL_MATCH.test(question.questionText || "");
  });
}

// Build the search matchers for a query. Each term must match a WHOLE word — so a
// two-word search like "Ben Maguire" can't sneak in via "benefit" (matching "ben") plus a
// "Maguire" somewhere else — except the LAST term, which matches as a prefix so
// search-as-you-type ("dent" → "dental") still works.
function buildQueryMatchers(query) {
  const words = query.split(/\s+/).filter(Boolean);
  return words.map((word, i) => {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return i === words.length - 1 ? new RegExp(`\\b${esc}`) : new RegExp(`\\b${esc}\\b`);
  });
}

function getFilteredQuestions(excludeMonth = false, excludeTopic = false, excludeParty = false, excludeRegion = false) {
  const query = state.query.trim().toLowerCase();
  const exactUin = query.match(/^(?:uin:?\s*)?(\d{2,})$/)?.[1] || "";
  const queryMatchers = query ? buildQueryMatchers(query) : [];

  return getScopedQuestions().filter((question) => {
    if (!excludeParty && state.party) {
      const party = question.member.partyAbbreviation || question.member.party || "Unknown";
      if (party !== state.party) return false;
    }

    if (!excludeRegion && state.region && question.region.nhsRegion !== state.region) return false;
    if (state.answer === "answered" && !question.answered) return false;
    if (state.answer === "unanswered" && question.answered) return false;

    if (exactUin) {
      return String(question.uin || "") === exactUin;
    }

    if (query) {
      // Member name and constituency are always searchable (they're metadata, not
      // question/answer text), so "Search question text only" still lets you find a
      // member by name — and clicking a name/constituency in the table just fills the
      // search with it.
      const questionFields = [
        question.heading,
        question.questionText,
        question.member?.name,
        question.member?.constituency,
      ];
      const fields = state.searchQuestionOnly
        ? questionFields
        : [...questionFields, question.answerText];
      const textToSearch = fields.filter(Boolean).join(" ").toLowerCase();
      if (!queryMatchers.every((re) => re.test(textToSearch))) return false;
    }

    if (!excludeMonth && state.selectedMonth) {
      const m = (question.dateTabled || "").slice(0, 7);
      if (m !== state.selectedMonth) return false;
    }

    if (state.tabledSince && (question.dateTabled || "") < state.tabledSince) return false;

    if (!excludeTopic && state.selectedTopic) {
      if (getQuestionTopic(question) !== state.selectedTopic) return false;
    }

    return true;
  });
}

function isMonthInPeriods(month) {
  if (state.periods.includes("all")) return true;
  const allKeys = Object.keys(PERIODS);
  const selectedKeys = allKeys.filter(k => state.periods.includes(k));
  if (selectedKeys.length === 0) return true;
  
  return selectedKeys.some(key => {
    const period = PERIODS[key];
    const monthStart = `${month}-01`;
    if (monthStart < period.start.slice(0, 7) + "-01") return false;
    if (period.end && monthStart >= period.end.slice(0, 7) + "-01") return false;
    return true;
  });
}

function renderMetrics(items) {
  const partyCounts = countBy(items, (question) => question.member.partyAbbreviation || question.member.party);
  const regionCounts = countBy(items, (question) => question.region.nhsRegion);
  const answered = items.filter((question) => question.answered).length;
  const newest = items.map((question) => question.dateTabled).filter(Boolean).sort().at(-1);

  elements.total.textContent = formatNumber.format(items.length);
  elements.answered.textContent = `${formatNumber.format(answered)} / ${formatNumber.format(items.length - answered)}`;
  elements.latest.textContent = shortDate(newest);
  elements.partyMetric.textContent = partyCounts[0]
    ? `${partyCounts[0].key} (${formatNumber.format(partyCounts[0].count)})`
    : "-";
  elements.regionMetric.textContent = regionCounts[0]
    ? `${regionCounts[0].key} (${formatNumber.format(regionCounts[0].count)})`
    : "-";
}

function renderScopeStatus(filteredCount) {
  if (!state.summary) return;
  const refreshed = formatGeneratedAt(state.summary.generatedAt);
  const info = getPeriodInfo();

  const filterParts = [];
  if (state.selectedTopic) {
    filterParts.push(`topic "${escapeHtml(state.selectedTopic)}"`);
  }
  if (state.party) {
    filterParts.push(`party "${escapeHtml(state.party)}"`);
  }
  if (state.region) {
    filterParts.push(`NHS region "${escapeHtml(state.region)}"`);
  }
  if (state.selectedMonth) {
    const [year, monthNum] = state.selectedMonth.split("-");
    const monthName = MONTH_NAMES[monthNum] || monthNum;
    filterParts.push(`month "${monthName} ${year}"`);
  }

  const total = formatNumber.format(state.summary.totals.questions);
  const shown = formatNumber.format(filteredCount);
  const terms = VERTICAL.plainEnglishTerms.join(", ");
  let statusText = `${total} ${VERTICAL.house} written questions to ${VERTICAL.answeringBodyLabel} mentioning ${VERTICAL.topic} (${terms}) · ${shown} shown · refreshed ${refreshed}`;

  if (filterParts.length > 0) {
    statusText += ` <span style="cursor:pointer; text-decoration:underline; font-weight:bold; margin-left:6px; color:#000000;" id="clear-filters-link">(clear filters)</span>`;
  }

  elements.status.innerHTML = statusText;
  renderRecentButtons();
  
  let footerText = `Stored source data goes back to ${shortDate(
    state.summary.dateRange.oldestTabled,
  )} and includes DHSC plus its predecessor Department of Health. This view ${info.dates}.`;
  if (state.selectedMonth) {
    const [year, monthNum] = state.selectedMonth.split("-");
    const monthName = MONTH_NAMES[monthNum] || monthNum;
    footerText += ` Filtered to show only questions from ${monthName} ${year}.`;
  }
  if (state.selectedTopic) {
    footerText += ` Filtered to show only questions under topic "${state.selectedTopic}".`;
  }
  if (state.party) {
    footerText += ` Filtered to show only questions from party "${state.party}".`;
  }
  if (state.region) {
    footerText += ` Filtered to show only questions from NHS region "${state.region}".`;
  }
  elements.footer.textContent = footerText;

  const clearBothBtn = document.querySelector("#clear-filters-link");
  if (clearBothBtn) {
    clearBothBtn.addEventListener("click", () => {
      state.selectedMonth = "";
      state.selectedTopic = "";
      state.party = "";
      state.region = "";
      elements.partyFilter.value = "";
      elements.regionFilter.value = "";
      render();
    });
  }
}

function renderSelects() {
  const scoped = getScopedQuestions();
  const parties = countBy(scoped, (question) => question.member.partyAbbreviation || question.member.party);
  const regions = countBy(scoped, (question) => question.region.nhsRegion);

  const partyStillPresent = !state.party || parties.some((party) => party.key === state.party);
  const regionStillPresent = !state.region || regions.some((region) => region.key === state.region);
  if (!partyStillPresent) state.party = "";
  if (!regionStillPresent) state.region = "";

  elements.partyFilter.innerHTML =
    '<option value="">All parties</option>' +
    parties.map((party) => `<option value="${escapeHtml(party.key)}">${escapeHtml(party.key)}</option>`).join("");
  elements.regionFilter.innerHTML =
    '<option value="">All NHS regions</option>' +
    regions.map((region) => `<option value="${escapeHtml(region.key)}">${escapeHtml(region.key)}</option>`).join("");
  elements.partyFilter.value = state.party;
  elements.regionFilter.value = state.region;
}

const getLineProps = (pointA, pointB) => {
  const lengthX = pointB.x - pointA.x;
  const lengthY = pointB.y - pointA.y;
  return {
    length: Math.sqrt(lengthX * lengthX + lengthY * lengthY),
    angle: Math.atan2(lengthY, lengthX),
  };
};

const getControlPoint = (current, previous, next, reverse) => {
  const p = previous || current;
  const n = next || current;
  const smoothing = 0.15;
  const o = getLineProps(p, n);
  const angle = o.angle + (reverse ? Math.PI : 0);
  const length = o.length * smoothing;
  const x = current.x + Math.cos(angle) * length;
  const y = current.y + Math.sin(angle) * length;
  return [x, y];
};

const getBezierPath = (points) => {
  return points.reduce((acc, point, i, a) => {
    if (i === 0) {
      return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    }
    const [cpsX, cpsY] = getControlPoint(a[i - 1], a[i - 2], point, false);
    const [cpeX, cpeY] = getControlPoint(point, a[i - 1], a[i + 1], true);
    return `${acc} C ${cpsX.toFixed(1)} ${cpsY.toFixed(1)}, ${cpeX.toFixed(1)} ${cpeY.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }, "");
};

// `precomputed` is an optional [{month, count}] series from summary.monthly, used for the
// first paint before the (much larger) questions file has arrived. Verified to produce an
// identical chart to the questions-derived one, so nothing visibly changes on swap.
function renderLineChart(items, precomputed = null) {
  let months; // [month, count, questions|null]
  if (precomputed) {
    months = precomputed.map((row) => [row.month, row.count, null]);
  } else {
    const byMonth = new Map();
    for (const question of items) {
      if (!question.dateTabled) continue;
      const month = question.dateTabled.slice(0, 7);
      if (!byMonth.has(month)) {
        byMonth.set(month, []);
      }
      byMonth.get(month).push(question);
    }
    months = [...byMonth.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, qs]) => [month, qs.length, qs]);
  }

  if (!months.length) {
    state.chartPoints = [];
    elements.monthlyChart.innerHTML = '<p class="chart-note">No matching monthly data.</p>';
    elements.monthlyRange.textContent = "";
    return;
  }

  const containerWidth = elements.monthlyChart ? elements.monthlyChart.clientWidth : 0;
  const width = containerWidth > 16 ? (containerWidth - 16) : 760;
  const height = 220;
  const pad = 28;
  const max = Math.max(...months.map(([, count]) => count), 1);
  const step = months.length > 1 ? (width - pad * 2) / (months.length - 1) : 0;
  const points = months.map(([month, count, monthQuestions], index) => {
    const x = pad + index * step;
    const y = height - pad - (count / max) * (height - pad * 2);
    // Topic breakdown needs the underlying questions; on the summary-only first paint the
    // tooltip just shows the month total until they load.
    const themeCounts = monthQuestions
      ? getTopicCounts(monthQuestions).filter((t) => t.count > 0).slice(0, 5)
      : [];
    return { month, count, x, y, themeCounts };
  });
  state.chartPoints = points;

  // Generate smooth spline path and area
  const path = getBezierPath(points);
  const area = points.length > 1 
    ? `${path} L ${points.at(-1).x.toFixed(1)} ${height - pad} L ${points[0].x.toFixed(1)} ${height - pad} Z`
    : "";

  // Dynamically calculate dot radius based on the number of points (longer time frames = smaller dots)
  let dotR = 4;
  if (points.length > 60) {
    dotR = 1.2;
  } else if (points.length > 30) {
    dotR = 2.0;
  } else if (points.length > 15) {
    dotR = 3.0;
  }
  const dotRActive = Math.max(3.5, dotR + 2);

  const monthTicks = [];
  const totalPoints = points.length;
  const numTicks = Math.min(6, totalPoints);
  const tickStep = totalPoints > 1 ? (totalPoints - 1) / Math.max(1, numTicks - 1) : 0;
  let lastYear = "";

  for (let i = 0; i < numTicks; i += 1) {
    const index = Math.min(totalPoints - 1, Math.round(i * tickStep));
    const point = points[index];
    const [year, monthNum] = point.month.split("-");
    const monthName = MONTH_NAMES[monthNum] || monthNum;
    const showYear = year !== lastYear ? year : "";
    lastYear = year;
    monthTicks.push({ label: monthName, x: point.x, year: showYear });
  }

  elements.monthlyRange.textContent = `${months[0][0]} to ${months.at(-1)[0]}`;
  elements.monthlyChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly dentistry PQ volume" style="--dot-r: ${dotR}px; --dot-r-active: ${dotRActive}px;">
      <line class="axis" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"></line>
      <line class="axis" x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}"></line>
      ${area ? `<path class="trend-area" d="${area}"></path>` : ""}
      ${path ? `<path class="trend-line" d="${path}"></path>` : ""}
      ${points
        .map(
          (point, index) => {
            const isActive = point.month === state.selectedMonth;
            return `
              <circle class="data-point${isActive ? " active" : ""}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" data-index="${index}"></circle>
            `;
          }
        )
        .join("")}
      ${monthTicks
        .map(
          (tick) => `
            <text x="${tick.x}" y="${height - 15}" text-anchor="middle" font-size="9" fill="#777">${tick.label}</text>
            ${tick.year ? `<text x="${tick.x}" y="${height - 3}" text-anchor="middle" font-size="10" font-weight="bold" fill="#333">${tick.year}</text>` : ""}
          `,
        )
        .join("")}
      <text x="${pad + 3}" y="${pad - 7}" font-size="10" fill="#666">${max}</text>
    </svg>
  `;
}

function getRowsAtLeastSnp(rows) {
  const snp = rows.find((row) => row.key === "SNP");
  if (!snp) return rows;
  return rows.filter((row) => row.count >= snp.count);
}

function renderBars(container, rows, options = {}) {
  const { limit = 10, snpFloor = false, selectedKey = "" } = options;
  const visible = (snpFloor ? getRowsAtLeastSnp(rows) : rows).slice(0, limit);
  const max = Math.max(...visible.map((row) => row.count), 1);
  container.innerHTML = visible.length
    ? visible
        .map(
          (row) => {
            const isActive = row.key === selectedKey;
            return `
              <div class="bar-row${isActive ? " active" : ""}" data-key="${escapeHtml(row.key)}">
                <span class="bar-label" title="${escapeHtml(row.key)}">${escapeHtml(row.key)}</span>
                <span class="bar-track"><span class="bar-fill" style="width:${Math.max(3, (row.count / max) * 100)}%"></span></span>
                <span class="bar-value">${formatNumber.format(row.count)}</span>
              </div>
            `;
          }
        )
        .join("")
    : '<p class="chart-note">No matching data.</p>';
}

function renderTable(items) {
  const limit = 150;
  const visible = items.slice(0, limit);
  answerByQid.clear();
  hideAnswerTip();
  elements.resultsCount.textContent = `showing ${formatNumber.format(visible.length)} of ${formatNumber.format(items.length)}`;
  
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  
  elements.table.innerHTML = visible
    .map(
      (question) => {
        const isOverdue = !question.answered && question.dateForAnswer && question.dateForAnswer < todayStr;
        let dueLabel = question.dateForAnswer ? shortDate(question.dateForAnswer) : "-";
        
        const indicators = [];
        if (question.isNamedDay) {
          indicators.push(`<span class="due-indicator named-day" title="Named Day">(ND)</span>`);
        }
        if (isOverdue) {
          indicators.push(`<span class="due-indicator overdue" title="Overdue">(O)</span>`);
        }
        
        const dueCellHtml = dueLabel + (indicators.length ? " " + indicators.join(" ") : "");

        const hasAnswer = question.answered && Boolean(question.answerText);
        if (hasAnswer) {
          answerByQid.set(String(question.id), question.answerText);
        }

        let tabledHtml = escapeHtml(shortDate(question.dateTabled));
        if (question.dateTabled === todayStr) {
          tabledHtml = `<span class="tabled-badge today" title="Tabled Today">⚡ TODAY</span>`;
        } else if (question.dateTabled === yesterdayStr) {
          tabledHtml = `<span class="tabled-badge yesterday" title="Tabled Yesterday">YESTERDAY</span>`;
        }

        return `
          <tr>
            <td><a href="${escapeHtml(question.url)}">${escapeHtml(question.uin)}</a></td>
            <td style="white-space: nowrap;">${tabledHtml}</td>
            <td style="white-space: nowrap;">${dueCellHtml}</td>
            <td><span class="party-dot" title="${escapeHtml(question.member.party || question.member.partyAbbreviation || "Unknown")}">${partyEmoji(question)}</span> ${filterLink(question.member.name)}</td>
            <td>${filterLink(question.member.constituency)}</td>
            <td>${escapeHtml(question.region.nhsRegion || "-")}</td>
            <td class="question-cell">
              <button class="row-menu" type="button" data-row-menu="${escapeHtml(String(question.id))}" title="More — find similar questions" aria-label="Row actions">☰</button>
              <div class="question-heading">${escapeHtml(question.heading || "Written question")}</div>
              <div class="question-text">${escapeHtml(question.questionText)}</div>
              <span class="status-pill ${question.answered ? "answered" : "unanswered"}${hasAnswer ? " has-answer-tip" : ""}"${hasAnswer ? ` data-qid="${escapeHtml(String(question.id))}"` : ""}>
                <span class="status-dot ${question.answered ? "green" : "amber"}"></span>
                ${question.answered ? "answered" : "unanswered"}
              </span>
            </td>
          </tr>
        `;
      }
    )
    .join("");
}

// ── Answer hover tooltip ─────────────────────────────────────────────────────
// A single body-level (position:fixed) popup, so it escapes the table's overflow
// clipping and can be positioned anywhere in the viewport.
let answerTipPill = null;
let answerTipHideTimer = null;

// Append a string to `parent`, turning bare http(s) URLs into real, clickable links.
// Built with DOM nodes (no innerHTML), so the API-derived text can't inject markup.
function appendTextWithLinks(parent, text) {
  const urlRe = /https?:\/\/[^\s<>]+/g;
  let last = 0;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    let url = m[0];
    // Don't swallow trailing sentence punctuation into the link.
    const trailing = (url.match(/[.,;:!?)\]}'"]+$/) || [""])[0];
    if (trailing) url = url.slice(0, url.length - trailing.length);
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement("a");
    a.href = url;
    a.textContent = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    parent.appendChild(a);
    if (trailing) parent.appendChild(document.createTextNode(trailing));
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// ── Copy the answer ──────────────────────────────────────────────────────────
// The popup is the only place the answer appears in full on this page, so it needs a
// way out: one button, copying exactly the text currently on screen.
let answerTipText = "";
let answerCopyResetTimer = null;

function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Plain http (a local file server, say) has no async clipboard API.
  return new Promise((resolve, reject) => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    copied ? resolve() : reject(new Error("copy rejected"));
  });
}

// Built once and kept: the popup re-renders when a longer answer arrives, and rebuilding
// the button there would wipe the "Copied" confirmation out from under the reader. The
// handler reads answerTipText at click time, so it always copies what is on screen.
let answerTipBody = null;
let answerCopyButton = null;

// Two stacked sheets for "copy", a tick for "copied" — drawn in currentColor at the
// same weight as the rest of the interface, so the popup stays uncluttered.
const COPY_ICON_SVG = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
       stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">
    <path d="M9 8H4v12h11v-4" />
    <path d="M9 4h7l5 5v7H9z" />
    <path d="M16 4v5h5" />
    <path d="M11.5 11.5h7M11.5 14h7" />
  </svg>`;

const COPIED_ICON_SVG = `
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
       stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>`;

function setAnswerCopyState(button, state) {
  button.innerHTML = state === "copied" ? COPIED_ICON_SVG : COPY_ICON_SVG;
  button.classList.toggle("copied", state === "copied");
  button.classList.toggle("failed", state === "failed");
  const label =
    state === "copied"
      ? "Answer copied"
      : state === "failed"
        ? "Copy failed — select the text and press Ctrl+C"
        : "Copy this answer";
  button.title = label;
  button.setAttribute("aria-label", label);
}

function resetAnswerCopyButton() {
  clearTimeout(answerCopyResetTimer);
  if (!answerCopyButton) return;
  setAnswerCopyState(answerCopyButton, "copy");
}

function buildAnswerCopyButton() {
  const row = document.createElement("div");
  row.className = "answer-tip-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "answer-copy";
  setAnswerCopyState(button, "copy");
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    copyTextToClipboard(answerTipText)
      .then(() => setAnswerCopyState(button, "copied"))
      .catch(() => setAnswerCopyState(button, "failed"))
      .finally(() => {
        clearTimeout(answerCopyResetTimer);
        answerCopyResetTimer = setTimeout(() => setAnswerCopyState(button, "copy"), 1600);
      });
  });
  row.appendChild(button);
  answerCopyButton = button;
  return row;
}

// The popup keeps a fixed shape: a body the content replaces, then the copy strip.
function ensureAnswerTipChrome() {
  const tip = elements.answerTooltip;
  if (answerTipBody && tip.contains(answerTipBody)) return;
  tip.textContent = "";
  answerTipBody = document.createElement("div");
  answerTipBody.className = "answer-tip-body";
  tip.appendChild(answerTipBody);
  tip.appendChild(buildAnswerCopyButton());
}

function setAnswerTipContent(text) {
  ensureAnswerTipChrome();
  const tip = answerTipBody;
  tip.textContent = "";
  answerTipText = String(text);
  // stripHtml separates paragraphs with newlines — render them as real paragraphs
  // (with spacing) rather than a wall of pre-wrapped text.
  const paras = String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const blocks = paras.length ? paras : [String(text)];
  for (const p of blocks) {
    const el = document.createElement("p");
    appendTextWithLinks(el, p);
    tip.appendChild(el);
  }
}

function positionAnswerTip(pill) {
  const tip = elements.answerTooltip;
  const margin = 8;
  const gap = 8;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const r = pill.getBoundingClientRect();

  const spaceAbove = r.top - gap - margin;
  const spaceBelow = vh - r.bottom - gap - margin;
  const placeAbove = spaceAbove > spaceBelow;

  // Cap the height to the room on the chosen side so the box never overlaps the
  // pill or spills off-screen; long answers scroll inside.
  const avail = Math.max(120, placeAbove ? spaceAbove : spaceBelow);
  tip.style.maxHeight = Math.min(avail, Math.round(vh * 0.7)) + "px";

  const th = tip.offsetHeight;
  const tw = tip.offsetWidth;
  let top = placeAbove ? r.top - gap - th : r.bottom + gap;
  top = Math.max(margin, Math.min(top, vh - th - margin));
  let left = Math.min(r.left, vw - tw - margin);
  left = Math.max(margin, left);

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function showAnswerTip(pill) {
  const qid = pill.getAttribute("data-qid") || "";
  const text = answerByQid.get(qid) || similarAnswerByQid.get(qid);
  if (!text) return;
  clearTimeout(answerTipHideTimer);
  answerTipPill = pill;
  setAnswerTipContent(text);
  elements.answerTooltip.scrollTop = 0;
  elements.answerTooltip.classList.add("visible");
  positionAnswerTip(pill);
}

function hideAnswerTip() {
  clearTimeout(answerTipHideTimer);
  answerTipPill = null;
  resetAnswerCopyButton();
  if (elements.answerTooltip) elements.answerTooltip.classList.remove("visible");
}

function scheduleHideAnswerTip() {
  clearTimeout(answerTipHideTimer);
  answerTipHideTimer = setTimeout(hideAnswerTip, 120);
}

// A member name / constituency rendered as a clickable filter: clicking it fills the
// search with that text and filters, landing you on that MP's questions as if typed in.
function filterLink(text) {
  if (!text) return "-";
  const safe = escapeHtml(text);
  return `<span class="filter-link" data-filter="${safe}" role="button" tabindex="0" title="Show questions from ${safe}">${safe}</span>`;
}

function applyFilterFromLink(link) {
  const term = link.getAttribute("data-filter") || "";
  state.query = term;
  if (elements.search) elements.search.value = term;
  render();
}

if (elements.table) {
  elements.table.addEventListener("click", (event) => {
    const link = event.target.closest(".filter-link");
    if (!link || !elements.table.contains(link)) return;
    event.preventDefault();
    applyFilterFromLink(link);
  });
  elements.table.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const link = event.target.closest(".filter-link");
    if (!link || !elements.table.contains(link)) return;
    event.preventDefault();
    applyFilterFromLink(link);
  });
}

// Any container holding `.has-answer-tip` pills can opt into the hover popup — the
// questions table, and the similar-questions panel.
function bindAnswerTipHover(container) {
  if (!elements.answerTooltip || !container) return;
  container.addEventListener("mouseover", (event) => {
    const pill = event.target.closest(".has-answer-tip");
    if (!pill || !container.contains(pill)) return;
    if (pill === answerTipPill) {
      clearTimeout(answerTipHideTimer);
      return;
    }
    showAnswerTip(pill);
  });
  container.addEventListener("mouseout", (event) => {
    const pill = event.target.closest(".has-answer-tip");
    if (!pill) return;
    const to = event.relatedTarget;
    if (to && (pill.contains(to) || elements.answerTooltip.contains(to))) return;
    scheduleHideAnswerTip();
  });
}

if (elements.answerTooltip && elements.table) {
  bindAnswerTipHover(elements.table);
  bindAnswerTipHover(elements.similarPanel);
  // Hover intent: moving the cursor into the tooltip (to read/scroll) keeps it open.
  elements.answerTooltip.addEventListener("mouseenter", () => clearTimeout(answerTipHideTimer));
  elements.answerTooltip.addEventListener("mouseleave", scheduleHideAnswerTip);
  // Dismiss on page scroll/resize, but ignore scrolling *inside* the tooltip.
  window.addEventListener(
    "scroll",
    (event) => {
      if (event.target !== elements.answerTooltip) hideAnswerTip();
    },
    true,
  );
  window.addEventListener("resize", hideAnswerTip);
}

// ── First paint from the summary ─────────────────────────────────────────────
// summary.json.enc is ~137KB and decrypts in ~30ms; questions.json.enc is ~7MB. Waiting
// for the big file before showing anything is what made the dashboard sit blank and then
// pop in. summary.monthly already carries per-month totals plus party/region breakdowns,
// which reproduce the default (current Parliament) view exactly — verified against the
// questions-derived numbers — so the headline view can be painted immediately and the
// questions swapped in underneath without anything visibly changing.
function summaryDefaultView() {
  const rows = (state.summary?.monthly || []).filter((r) => isMonthInPeriods(r.month));
  const totals = { total: 0, answered: 0 };
  const party = new Map();
  const region = new Map();
  for (const r of rows) {
    totals.total += r.total || 0;
    totals.answered += r.answered || 0;
    for (const [k, v] of Object.entries(r.byParty || {})) party.set(k, (party.get(k) || 0) + v);
    for (const [k, v] of Object.entries(r.byRegion || {})) region.set(k, (region.get(k) || 0) + v);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    series: rows.map((r) => ({ month: r.month, count: r.total })),
    totals,
    topParty: top(party),
    topRegion: top(region),
  };
}

function paintFromSummary() {
  if (!state.summary) return;
  const view = summaryDefaultView();

  elements.total.textContent = formatNumber.format(view.totals.total);
  elements.answered.textContent = `${formatNumber.format(view.totals.answered)} / ${formatNumber.format(
    view.totals.total - view.totals.answered,
  )}`;
  elements.latest.textContent = shortDate(state.summary.dateRange?.newestTabled);
  elements.partyMetric.textContent = view.topParty
    ? `${view.topParty[0]} (${formatNumber.format(view.topParty[1])})`
    : "-";
  elements.regionMetric.textContent = view.topRegion
    ? `${view.topRegion[0]} (${formatNumber.format(view.topRegion[1])})`
    : "-";

  renderLineChart([], view.series);
  renderScopeStatus(view.totals.total);
  elements.resultsCount.textContent = "loading questions…";
  elements.table.innerHTML = `<tr><td colspan="7" class="table-loading">Loading questions…</td></tr>`;
}

function render() {
  if (state.selectedMonth && !isMonthInPeriods(state.selectedMonth)) {
    state.selectedMonth = "";
  }

  const filtered = getFilteredQuestions();
  const lineChartFiltered = getFilteredQuestions(true, false, false, false);
  const themeChartFiltered = getFilteredQuestions(false, true, false, false);
  const partyChartFiltered = getFilteredQuestions(false, false, true, false);
  const regionChartFiltered = getFilteredQuestions(false, false, false, true);

  renderScopeStatus(filtered.length);
  renderMetrics(filtered);
  renderLineChart(lineChartFiltered);
  renderBars(elements.themeChart, getTopicCounts(themeChartFiltered), {
    limit: 100,
    selectedKey: state.selectedTopic
  });
  renderBars(elements.partyChart, countBy(partyChartFiltered, (question) => question.member.partyAbbreviation || question.member.party), {
    limit: 30,
    snpFloor: true,
    selectedKey: state.party
  });
  renderBars(elements.regionChart, countBy(regionChartFiltered, (question) => question.region.nhsRegion), {
    limit: 12,
    selectedKey: state.region
  });
  renderTable(filtered);
}

// ── Export to Excel ───────────────────────────────────────────
// Downloads the questions currently in scope as an .xlsx. Full answers are already in the
// dataset for this vertical, so the export needs no live fetching — it is instant. SheetJS
// (~950KB, vendored) is loaded lazily on the first export, not on every page view.
const XLSX_SRC = "scripts/vendor/xlsx.full.min.js";

let xlsxLibPromise = null;
function loadXlsxLib() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxLibPromise) return xlsxLibPromise;
  xlsxLibPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = XLSX_SRC;
    script.onload = () =>
      window.XLSX ? resolve(window.XLSX) : reject(new Error("spreadsheet library failed to initialise"));
    script.onerror = () => reject(new Error("could not load the spreadsheet library"));
    document.head.appendChild(script);
  });
  return xlsxLibPromise;
}

function exportYesNo(value) {
  return value ? "Yes" : "No";
}

// One spreadsheet row per question. Key order here IS the column order in the file.
function exportRow(q, todayStr) {
  const overdue = !q.answered && q.dateForAnswer && q.dateForAnswer < todayStr;
  return {
    UIN: q.uin || "",
    "Date tabled": q.dateTabled || "",
    "Date due": q.dateForAnswer || "",
    "Date answered": q.dateAnswered || "",
    Status: q.answered ? "Answered" : "Unanswered",
    Overdue: q.answered ? "" : exportYesNo(overdue),
    "Named day": exportYesNo(q.isNamedDay),
    Subject: getQuestionTopic(q),
    Member: q.member?.name || "",
    Party: q.member?.party || q.member?.partyAbbreviation || "",
    Constituency: q.member?.constituency || "",
    Nation: q.region?.nation || "",
    "NHS region": q.region?.nhsRegion || "",
    Heading: q.heading || "",
    Question: q.questionText || "",
    Answer: q.answered ? q.answerText || "" : "",
    "Answer complete": q.answered ? exportYesNo(Boolean(q.answerFull)) : "",
    URL: q.url || "",
  };
}

function exportSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function exportScopeSlug() {
  const period = getPeriodInfo();
  const periodPart = period.label === "current Parliament" ? "" : period.label;
  const parts = [
    state.selectedTopic,
    state.party,
    state.region,
    state.answer,
    state.selectedMonth,
    periodPart,
    state.query.trim(),
  ]
    .map(exportSlug)
    .filter(Boolean);
  return parts.join("_") || "all";
}

function exportScopeDescription() {
  const parts = [];
  if (state.query.trim()) {
    parts.push(`search: "${state.query.trim()}"${state.searchQuestionOnly ? " (question text only)" : ""}`);
  }
  if (state.selectedTopic) parts.push(`topic: ${state.selectedTopic}`);
  if (state.party) parts.push(`party: ${state.party}`);
  if (state.region) parts.push(`NHS region: ${state.region}`);
  if (state.answer) parts.push(`answer status: ${state.answer}`);
  if (state.selectedMonth) {
    const [year, monthNum] = state.selectedMonth.split("-");
    parts.push(`month: ${MONTH_NAMES[monthNum] || monthNum} ${year}`);
  }
  parts.push(`period: ${getPeriodInfo().label}`);
  return parts.join("; ");
}

let exportBusy = false;
function setExportBusy(busy, label) {
  exportBusy = busy;
  if (!elements.exportButton) return;
  elements.exportButton.disabled = busy;
  const span = elements.exportButton.querySelector(".btn-export-label");
  if (span) span.textContent = label;
}

function buildExportWorkbook(XLSX, rows) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const dataRows = rows.map((q) => exportRow(q, todayStr));

  const ws = XLSX.utils.json_to_sheet(dataRows);
  ws["!cols"] = [8, 12, 12, 12, 11, 8, 10, 22, 22, 8, 26, 14, 22, 30, 60, 90, 9, 46].map((wch) => ({
    wch,
  }));
  ws["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dataRows.length, c: 17 } }),
  };

  const answered = rows.filter((q) => q.answered).length;
  const about = [
    [`${VERTICAL.brandTitle} — data export`],
    [],
    ["Generated", new Date().toLocaleString("en-GB")],
    ["Scope (filters)", exportScopeDescription()],
    ["Questions in scope", rows.length],
    ["Answered / unanswered", `${answered} / ${rows.length - answered}`],
    [],
    ["Source", "UK Parliament Written Questions API (questions-statements-api.parliament.uk)"],
    ["Answering body", `${VERTICAL.answeringBodyLabel} — House of ${VERTICAL.house}`],
    ["Scope", `Questions mentioning ${VERTICAL.topic}`],
    [
      "Note on answers",
      "Answer text is the full answer stored in the dataset. A few answered questions may still carry only the ~250-character extract — see the 'Answer complete' column.",
    ],
  ];
  const wsAbout = XLSX.utils.aoa_to_sheet(about);
  wsAbout["!cols"] = [{ wch: 22 }, { wch: 96 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Questions");
  XLSX.utils.book_append_sheet(wb, wsAbout, "About");
  return { wb, todayStr };
}

async function exportInScopeToXlsx() {
  if (exportBusy) return;
  const rows = getFilteredQuestions();
  if (!rows.length) {
    window.alert("No questions are in scope to export. Adjust the filters and try again.");
    return;
  }
  setExportBusy(true, "Building file…");
  try {
    const XLSX = await loadXlsxLib();
    const { wb, todayStr } = buildExportWorkbook(XLSX, rows);
    XLSX.writeFile(wb, `${VERTICAL.id}-pqs_${exportScopeSlug()}_${todayStr}.xlsx`);
    setExportBusy(false, "Exported ✓");
    setTimeout(() => setExportBusy(false, "Export to Excel"), 2500);
  } catch (error) {
    console.error(error);
    window.alert(`Export failed: ${error.message || error}`);
    setExportBusy(false, "Export to Excel");
  }
}

if (elements.exportButton) {
  elements.exportButton.addEventListener("click", exportInScopeToXlsx);
}

async function loadData() {
  // Try encrypted files first; fall back to plaintext for local dev
  const encSummaryResp = await fetch(`data/${VERTICAL.id}/summary.json.enc`, { cache: "no-store" });
  const encQuestionsResp = await fetch(`data/${VERTICAL.id}/questions.json.enc`, { cache: "no-store" });

  if (encSummaryResp.ok && encQuestionsResp.ok) {
    // Encrypted mode — need password to decrypt
    const summaryEnvelope = await encSummaryResp.json();
    const questionsEnvelope = await encQuestionsResp.json();

    while (true) {
      const password = await passwordReady;
      try {
        // Decrypt the small summary first and paint the headline view from it, so the
        // dashboard appears immediately instead of waiting on the ~7MB questions file.
        const summaryJson = await decryptPayload(summaryEnvelope, password);
        state.summary = JSON.parse(summaryJson);

        // Success — store password for session and remove overlay
        sessionStorage.setItem("pq-auth-ok", password);
        const overlay = document.getElementById("auth-overlay");
        if (overlay) overlay.remove();
        document.querySelector(".page").style.display = "";
        paintFromSummary();

        // Then the questions, in the background. The summary-derived view matches what
        // these produce, so the swap is invisible apart from the table filling in.
        const questionsJson = await decryptPayload(questionsEnvelope, password);
        state.questions = JSON.parse(questionsJson).questions || [];
        return;
      } catch {
        // Decryption failed. This is usually a wrong password, but it also happens when a
        // stored session password has gone stale — in which case there is no overlay yet,
        // so build one rather than dead-ending on a blank page. Either way, drop the bad
        // stored password and wait for a fresh attempt.
        sessionStorage.removeItem("pq-auth-ok");
        if (!document.getElementById("auth-overlay")) buildAuthOverlay();
        const overlay = document.getElementById("auth-overlay");
        if (overlay) {
          document.getElementById("auth-error").style.display = "block";
          document.getElementById("auth-btn").textContent = "Enter";
          document.getElementById("auth-input").value = "";
          document.getElementById("auth-input").focus();
          await awaitNextPassword();
          continue;
        }
        throw new Error("Decryption failed.");
      }
    }
  }

  // Plaintext fallback (local dev without encryption)
  const [summaryResponse, questionsResponse] = await Promise.all([
    fetch(`data/${VERTICAL.id}/summary.json`, { cache: "no-store" }),
    fetch(`data/${VERTICAL.id}/questions.json`, { cache: "no-store" }),
  ]);
  if (!summaryResponse.ok || !questionsResponse.ok) {
    throw new Error("Dashboard data could not be loaded.");
  }
  state.summary = await summaryResponse.json();
  const questionsPayload = await questionsResponse.json();
  state.questions = questionsPayload.questions || [];

  // No encryption — dismiss overlay if present (cached session)
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.remove();
  document.querySelector(".page").style.display = "";
}

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

for (const checkbox of elements.periodCheckboxes) {
  checkbox.addEventListener("change", (event) => {
    const value = event.target.value;
    const checked = event.target.checked;

    if (value === "all") {
      for (const cb of elements.periodCheckboxes) {
        if (cb.value !== "all") {
          cb.checked = checked;
        }
      }
    } else {
      if (!checked) {
        const allCb = [...elements.periodCheckboxes].find((cb) => cb.value === "all");
        if (allCb) allCb.checked = false;
      } else {
        const individualCbs = [...elements.periodCheckboxes].filter((cb) => cb.value !== "all");
        const allChecked = individualCbs.every((cb) => cb.checked);
        if (allChecked) {
          const allCb = [...elements.periodCheckboxes].find((cb) => cb.value === "all");
          if (allCb) allCb.checked = true;
        }
      }
    }

    state.periods = [...elements.periodCheckboxes]
      .filter((cb) => cb.checked)
      .map((cb) => cb.value);

    renderSelects();
    render();
  });
}

if (elements.searchQuestionOnly) {
  elements.searchQuestionOnly.addEventListener("change", (event) => {
    state.searchQuestionOnly = event.target.checked;
    render();
  });
}



elements.partyFilter.addEventListener("change", (event) => {
  state.party = event.target.value;
  render();
});

elements.regionFilter.addEventListener("change", (event) => {
  state.region = event.target.value;
  render();
});

elements.answerFilter.addEventListener("change", (event) => {
  state.answer = event.target.value;
  render();
});

elements.themeChart.addEventListener("click", (event) => {
  const row = event.target.closest(".bar-row");
  if (!row) return;

  const topic = row.getAttribute("data-key");
  if (!topic) return;

  if (state.selectedTopic === topic) {
    state.selectedTopic = "";
  } else {
    state.selectedTopic = topic;
  }
  render();
});

elements.partyChart.addEventListener("click", (event) => {
  const row = event.target.closest(".bar-row");
  if (!row) return;

  const party = row.getAttribute("data-key");
  if (!party) return;

  if (state.party === party) {
    state.party = "";
  } else {
    state.party = party;
  }
  elements.partyFilter.value = state.party;
  render();
});

elements.regionChart.addEventListener("click", (event) => {
  const row = event.target.closest(".bar-row");
  if (!row) return;

  const region = row.getAttribute("data-key");
  if (!region) return;

  if (state.region === region) {
    state.region = "";
  } else {
    state.region = region;
  }
  elements.regionFilter.value = state.region;
  render();
});

// Is a date inside any of the currently selected Parliament periods?
function isDateInSelectedPeriods(date) {
  if (state.periods.includes("all")) return true;
  return Object.keys(PERIODS)
    .filter((k) => state.periods.includes(k))
    .some((k) => {
      const p = PERIODS[k];
      if (date < p.start) return false;
      if (p.end && date >= p.end) return false;
      return true;
    });
}

// ── Row menu → similar questions panel ───────────────────────────────────────
let openRowMenuId = null;

function closeSimilarPanel() {
  openRowMenuId = null;
  similarAnswerByQid.clear();
  hideAnswerTip();
  if (elements.similarPanel) elements.similarPanel.hidden = true;
}

function positionSimilarPanel(anchor) {
  const panel = elements.similarPanel;
  const margin = 8;
  const gap = 6;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const r = anchor.getBoundingClientRect();

  const spaceBelow = vh - r.bottom - gap - margin;
  const spaceAbove = r.top - gap - margin;
  const below = spaceBelow >= spaceAbove;
  panel.style.maxHeight = `${Math.max(160, Math.min(below ? spaceBelow : spaceAbove, Math.round(vh * 0.7)))}px`;

  const h = panel.offsetHeight;
  const w = panel.offsetWidth;
  let top = below ? r.bottom + gap : r.top - gap - h;
  top = Math.max(margin, Math.min(top, vh - h - margin));
  // Right-align to the button, since it sits at the row's right edge.
  let left = Math.min(r.right - w, vw - w - margin);
  left = Math.max(margin, left);
  panel.style.top = `${Math.round(top)}px`;
  panel.style.left = `${Math.round(left)}px`;
}

function openSimilarPanel(anchor, question) {
  const panel = elements.similarPanel;
  if (!panel) return;
  const hits = findSimilarQuestions(question, 3);

  // Feed the hover popup the same way renderTable does, so the answer is readable
  // here rather than only on parliament.uk.
  similarAnswerByQid.clear();
  for (const h of hits) {
    if (h.question.answerText) similarAnswerByQid.set(String(h.question.id), h.question.answerText);
  }

  const rows = hits.length
    ? hits
        .map(
          (h) => `
            <li class="similar-item">
              <div class="similar-meta">
                <span class="similar-uin">UIN ${escapeHtml(h.question.uin)}</span>
                <span>${escapeHtml(shortDate(h.question.dateTabled))}</span>
                <span>${escapeHtml(h.question.member.name || "-")}</span>
                <span class="similar-score" title="Similarity score">${Math.round(h.score * 100)}%</span>
              </div>
              <div class="similar-heading">${escapeHtml(h.question.heading || "Written question")}</div>
              <div class="similar-text">${escapeHtml(String(h.question.questionText || "").replace(PQ_OPENER, ""))}</div>
              <div class="similar-actions">
                ${
                  h.question.answerText
                    ? `<span class="status-pill answered has-answer-tip" data-qid="${escapeHtml(String(h.question.id))}" title="Hover to read the answer">
                         <span class="status-dot green"></span>
                         read answer
                       </span>`
                    : ""
                }
                <a class="similar-link" href="${escapeHtml(h.question.url)}" target="_blank" rel="noopener noreferrer">View on parliament.uk ↗</a>
              </div>
            </li>`,
        )
        .join("")
    : `<li class="similar-empty">No closely similar answered questions in the current Parliament.</li>`;

  panel.innerHTML = `
    <div class="similar-head">
      <span>Similar questions <span class="beta-badge">BETA</span></span>
      <button type="button" class="similar-close" aria-label="Close">✕</button>
    </div>
    <p class="similar-note">Answered questions from the current Parliament only (from ${escapeHtml(shortDate(SIMILAR_PERIOD.start))}). Matched on wording, not meaning — treat as a starting point, not a definitive set.</p>
    <ul class="similar-list">${rows}</ul>`;

  panel.hidden = false;
  positionSimilarPanel(anchor);
  openRowMenuId = question.id;
}

document.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-row-menu]");
  if (btn) {
    event.stopPropagation();
    const id = Number(btn.dataset.rowMenu);
    if (openRowMenuId === id) return closeSimilarPanel();
    const question = state.questions.find((q) => q.id === id);
    if (question) openSimilarPanel(btn, question);
    return;
  }
  if (
    elements.similarPanel &&
    !elements.similarPanel.hidden &&
    !event.target.closest("#similar-panel") &&
    !event.target.closest("#answer-tooltip")
  ) {
    closeSimilarPanel();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSimilarPanel();
});

if (elements.similarPanel) {
  elements.similarPanel.addEventListener("click", (event) => {
    if (event.target.closest(".similar-close")) closeSimilarPanel();
  });
}

window.addEventListener("resize", closeSimilarPanel);
// Dismiss on page scroll, but not when the scrolling happens inside the panel itself
// or inside the answer popup it opened — those are the reader working through a result.
window.addEventListener(
  "scroll",
  (event) => {
    const target = event.target;
    if (target instanceof Node) {
      if (elements.similarPanel && elements.similarPanel.contains(target)) return;
      if (elements.answerTooltip && elements.answerTooltip.contains(target)) return;
    }
    closeSimilarPanel();
  },
  true,
);

// Today / Past three days, both toggling. The recent days normally sit inside the
// default "Current Parliament", so the period filter is left alone — it's only widened
// when the selected period would exclude them and the button would return nothing.
function applyRecentFilter(from) {
  state.tabledSince = state.tabledSince === from ? "" : from;
  if (state.tabledSince && !isDateInSelectedPeriods(latestTabledDate())) {
    state.periods = ["all"];
    elements.periodCheckboxes.forEach((cb) => {
      cb.checked = cb.value === "all";
    });
  }
  render();
}

if (elements.filterToday) {
  elements.filterToday.addEventListener("click", () => {
    const r = recentRanges();
    if (r) applyRecentFilter(r.today);
  });
}

if (elements.filterThreeDays) {
  elements.filterThreeDays.addEventListener("click", () => {
    const r = recentRanges();
    if (r) applyRecentFilter(r.threeDays);
  });
}

elements.resetFilters.addEventListener("click", () => {
  state.query = "";
  state.party = "";
  state.region = "";
  state.answer = "";
  state.periods = ["current"];
  state.selectedMonth = "";
  state.selectedTopic = "";
  state.tabledSince = "";

  elements.search.value = "";
  if (elements.searchQuestionOnly) {
    elements.searchQuestionOnly.checked = true;
  }
  state.searchQuestionOnly = true;


  elements.partyFilter.value = "";
  elements.regionFilter.value = "";
  elements.answerFilter.value = "";

  for (const cb of elements.periodCheckboxes) {
    cb.checked = (cb.value === "current");
  }

  renderSelects();
  render();
});

elements.monthlyChart.addEventListener("mouseover", (event) => {
  const dot = event.target.closest(".data-point");
  if (!dot) return;
  const index = parseInt(dot.getAttribute("data-index"), 10);
  const point = state.chartPoints[index];
  if (!point) return;

  const [year, monthNum] = point.month.split("-");
  const monthName = MONTH_NAMES[monthNum] || monthNum;
  const titleText = `${monthName} ${year}`;

  const rowsHtml = point.themeCounts
    .map(
      (theme) => `
      <div class="chart-tooltip-row">
        <span class="chart-tooltip-label">${escapeHtml(theme.key)}</span>
        <span class="chart-tooltip-value">${formatNumber.format(theme.count)}</span>
      </div>
    `
    )
    .join("");

  elements.tooltip.innerHTML = `
    <div class="chart-tooltip-title">${titleText}</div>
    <div class="chart-tooltip-row" style="border-bottom: 1px dashed var(--line); padding-bottom: 3px; margin-bottom: 5px;">
      <span class="chart-tooltip-label" style="font-weight: bold; color: var(--text);">Total PQs</span>
      <span class="chart-tooltip-value">${formatNumber.format(point.count)}</span>
    </div>
    ${rowsHtml}
  `;
  elements.tooltip.style.opacity = "1";
});

elements.monthlyChart.addEventListener("mousemove", (event) => {
  elements.tooltip.style.left = `${event.pageX + 12}px`;
  elements.tooltip.style.top = `${event.pageY + 12}px`;
});

elements.monthlyChart.addEventListener("mouseout", (event) => {
  const dot = event.target.closest(".data-point");
  if (!dot) return;
  elements.tooltip.style.opacity = "0";
});

elements.monthlyChart.addEventListener("click", (event) => {
  event.stopPropagation(); // Prevent document click handler from immediately clearing state.selectedMonth
  if (state.chartPoints.length === 0) return;

  // Direct dot click (or programmatic test events)
  const dot = event.target.closest(".data-point");
  if (dot) {
    const index = parseInt(dot.getAttribute("data-index"), 10);
    const point = state.chartPoints[index];
    if (point) {
      if (state.selectedMonth === point.month) {
        state.selectedMonth = "";
      } else {
        state.selectedMonth = point.month;
      }
      render();
      return;
    }
  }

  // Fallback: Click anywhere on column coordinates
  const svg = elements.monthlyChart.querySelector("svg");
  if (!svg) return;

  const rect = svg.getBoundingClientRect();
  const clickXRel = event.clientX - rect.left;
  const clickYRel = event.clientY - rect.top;
  
  const viewBoxAttr = svg.getAttribute("viewBox");
  const viewBoxParts = viewBoxAttr ? viewBoxAttr.split(/\s+/) : [];
  const viewBoxWidth = viewBoxParts[2] ? parseFloat(viewBoxParts[2]) : 760;
  const viewBoxHeight = viewBoxParts[3] ? parseFloat(viewBoxParts[3]) : 220;
  
  const svgX = (clickXRel / rect.width) * viewBoxWidth;
  const svgY = (clickYRel / rect.height) * viewBoxHeight;

  const pad = 28;
  const buffer = 10;

  // Check if click is outside plot area boundaries (e.g., margins/padding)
  if (
    svgX < pad - buffer ||
    svgX > (viewBoxWidth - pad) + buffer ||
    svgY < pad - buffer ||
    svgY > (viewBoxHeight - pad) + buffer
  ) {
    state.selectedMonth = "";
    render();
    return;
  }

  let closestPoint = null;
  let minDistance = Infinity;

  for (const point of state.chartPoints) {
    const dist = Math.abs(point.x - svgX);
    if (dist < minDistance) {
      minDistance = dist;
      closestPoint = point;
    }
  }

  if (closestPoint) {
    if (svgX >= pad - 10 && svgX <= (viewBoxWidth - pad) + 10) {
      if (state.selectedMonth === closestPoint.month) {
        state.selectedMonth = "";
      } else {
        state.selectedMonth = closestPoint.month;
      }
      render();
    }
  }
});

document.addEventListener("click", (event) => {
  if (!state.selectedMonth) return;

  const isInsideChart = elements.monthlyChart.contains(event.target);
  const isInsideFilterControl = 
    (elements.search && elements.search.contains(event.target)) ||
    (elements.partyFilter && elements.partyFilter.contains(event.target)) ||
    (elements.regionFilter && elements.regionFilter.contains(event.target)) ||
    (elements.answerFilter && elements.answerFilter.contains(event.target)) ||
    (elements.searchQuestionOnly && elements.searchQuestionOnly.contains(event.target)) ||

    ([...elements.periodCheckboxes].some(cb => cb.contains(event.target))) ||
    (elements.resetFilters && elements.resetFilters.contains(event.target));

  // The row menu, the similar-questions panel and the answer popup are their own UI —
  // clicking into them (to copy an answer, say) is not a click away from the chart.
  if (
    event.target.closest("[data-row-menu]") ||
    event.target.closest("#similar-panel") ||
    event.target.closest("#answer-tooltip")
  ) {
    return;
  }

  const isClearLink = 
    event.target.id === "clear-month-filter" ||
    event.target.id === "clear-topic-filter" ||
    event.target.id === "clear-filters-link";

  if (isInsideChart || isInsideFilterControl || isClearLink) {
    return;
  }

  state.selectedMonth = "";
  render();
});

let resizeTimeout;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeTimeout);
  resizeTimeout = requestAnimationFrame(() => {
    render();
  });
});

// Apply the vertical's branding so a new version only needs config.js edits.
function applyVerticalBranding() {
  document.title = VERTICAL.brandTitle;
  const brand = document.querySelector(".brand");
  if (brand) brand.textContent = VERTICAL.brandTitle;
  const totalLabel = document.querySelector("#metric-total-label");
  if (totalLabel) totalLabel.textContent = `Total ${VERTICAL.topic} PQs`;
}
applyVerticalBranding();

loadData()
  .then(() => {
    if (elements.searchQuestionOnly) {
      elements.searchQuestionOnly.checked = state.searchQuestionOnly;
    }

    renderSelects();
    render();

    // Test hook for headless screenshots
    if (window.location.search.includes("test-tooltip=true")) {
      setTimeout(() => {
        const dot = document.querySelector(".data-point");
        if (dot) {
          const rect = dot.getBoundingClientRect();
          const clientX = rect.left + window.scrollX;
          const clientY = rect.top + window.scrollY;

          dot.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
          dot.dispatchEvent(
            new MouseEvent("mousemove", {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: clientX + 10,
              clientY: clientY + 10,
              pageX: clientX + 10,
              pageY: clientY + 10,
            })
          );
        }
      }, 50);
    } else if (window.location.search.includes("test-click=true")) {
      setTimeout(() => {
        const dot = document.querySelector(".data-point");
        if (dot) {
          dot.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
      }, 50);
    } else if (window.location.search.includes("test-outside-click=true")) {
      setTimeout(() => {
        const dot = document.querySelector(".data-point");
        if (dot) {
          // Select the month
          dot.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          
          // Click outside the plot area boundaries after 100ms
          setTimeout(() => {
            elements.monthlyChart.dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: 0,
              clientY: 0
            }));
          }, 100);
        }
      }, 50);
    } else if (window.location.search.includes("test-global-deselect=true")) {
      setTimeout(() => {
        const dot = document.querySelector(".data-point");
        if (dot) {
          // Select the month
          dot.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          
          // Click document body (outside chart) after 100ms
          setTimeout(() => {
            document.body.dispatchEvent(new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              view: window
            }));
          }, 100);
        }
      }, 50);
    } else if (window.location.search.includes("test-all-parliaments=true")) {
      setTimeout(() => {
        const allCb = [...elements.periodCheckboxes].find((cb) => cb.value === "all");
        if (allCb) {
          allCb.checked = true;
          allCb.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, 50);
    } else if (window.location.search.includes("test-topic-click=true")) {
      const row = document.querySelector('.bar-row[data-key="Access and Waiting Times"]');
      if (row) {
        row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
    } else if (window.location.search.includes("test-reset-click=true")) {
      // Set search query and some filters first
      elements.search.value = "workforce";
      elements.search.dispatchEvent(new Event("input", { bubbles: true }));
      
      const row = document.querySelector('.bar-row[data-key="Access and Waiting Times"]');
      if (row) {
        row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
      
      // Trigger reset click synchronously
      elements.resetFilters.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } else if (window.location.search.includes("test-multi-select=true")) {
      const topicRow = document.querySelector('.bar-row[data-key="COVID-19"]');
      if (topicRow) {
        topicRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
      const partyRow = document.querySelector('.bar-row[data-key="Lab"]');
      if (partyRow) {
        partyRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
      const regionRow = document.querySelector('.bar-row[data-key="London"]');
      if (regionRow) {
        regionRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
    }
  })
  .catch((error) => {
    console.error(error);
    elements.status.textContent = "Could not load dashboard data from this repo.";
  });


