#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getVertical, DEFAULT_VERTICAL_ID } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dataDir = path.join(repoRoot, "data");

// Which vertical are we building? `node refresh-data.mjs --vertical=hospice`
// (defaults to DEFAULT_VERTICAL_ID). Per-vertical outputs live in data/<id>/;
// geography files (constituency-*) are shared at data/.
const verticalArg = process.argv.find((a) => a.startsWith("--vertical="));
const VERTICAL = getVertical(verticalArg ? verticalArg.split("=")[1] : DEFAULT_VERTICAL_ID);
const verticalDir = path.join(dataDir, VERTICAL.id);
console.log(`Building vertical "${VERTICAL.id}" (searchTerm: ${VERTICAL.searchTerm})`);

const QUESTIONS_ENDPOINT =
  "https://questions-statements-api.parliament.uk/api/writtenquestions/questions";
const DETAIL_BASE = "https://questions-statements.parliament.uk/written-questions/detail";
const CONSTITUENCY_CSV =
  "https://pages.mysociety.org/2025-constituencies/data/parliament_con_2025/latest/parl_constituencies_2025.csv";
const CONSTITUENCY_2020_CSV =
  "https://open-geography-portalx-ons.hub.arcgis.com/api/download/v1/items/0dbc00e2529e42b1807e04ddb1da6df5/csv?layers=0";
const PARL10_TO_PARL25_CSV =
  "https://pages.mysociety.org/2025-constituencies/data/geographic_overlaps/latest/PARL10_PARL25_combo_overlap.csv";
const TOPIC_TAXONOMY_PATH = path.join(verticalDir, "topic-taxonomy.json");

const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const SOURCE_PARAMS = {
  house: VERTICAL.house,
  answeringBodies: VERTICAL.answeringBodies,
  answered: "Any",
  includeWithdrawn: "false",
  expandMember: "true",
  searchTerm: VERTICAL.searchTerm,
};

// Word-boundary, case-insensitive regex built from the vertical's match roots,
// used to keep only questions whose heading or text actually mentions the topic.
const VERTICAL_MATCH = new RegExp(`\\b(${VERTICAL.matchRoots.join("|")})`, "i");

function matchesVertical(q) {
  return VERTICAL_MATCH.test(q.heading || "") || VERTICAL_MATCH.test(q.questionText || "");
}

const NHS_REGION_BY_PARLIAMENT_REGION = new Map([
  ["eastern", "East of England"],
  ["east of england", "East of England"],
  ["london", "London"],
  ["north east", "North East and Yorkshire"],
  ["yorkshire and the humber", "North East and Yorkshire"],
  ["yorkshire and the humber region", "North East and Yorkshire"],
  ["north west", "North West"],
  ["east midlands", "Midlands"],
  ["west midlands", "Midlands"],
  ["south east", "South East"],
  ["south west", "South West"],
]);

const DEVOLVED_NATIONS = new Set(["Scotland", "Wales", "Northern Ireland"]);
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "being", "by", "for", "from", "has",
  "have", "how", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "their", "them",
  "there", "these", "this", "those", "to", "was", "were", "what", "when", "where", "which", "who",
  "why", "will", "with", "would", "could", "should", "department", "health", "social", "care",
  "asked", "ask", "minister", "state", "secretary", "whether", "if", "made", "make", "plans",
  "plan", "number", "many", "dentistry", "dental", "dentist", "dentists",
]);
const TOPIC_WINDOW_MONTHS = 6;
const TOPIC_MIN_COUNT = 3;
const TOPIC_LIMIT = 8;
const POLICY_TERMS = [
  "nhs",
  "contract",
  "uda",
  "workforce",
  "recruit",
  "retain",
  "waiting",
  "access",
  "appointment",
  "charge",
  "afford",
  "fluor",
  "prevention",
  "oral health",
  "children",
  "commission",
  "icb",
  "covid",
  "pandemic",
  "training",
  "education",
  "dent",
];

function simpleHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function toTopicText(question) {
  return `${question.heading || ""} ${question.questionText || ""}`.toLowerCase();
}

function normaliseTopicToken(token) {
  return token.replace(/[^a-z0-9-]+/g, "").replace(/^-+|-+$/g, "");
}

function extractTopicPhrases(text) {
  const rawTokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .map(normaliseTopicToken)
    .filter(Boolean);

  const tokens = rawTokens.filter(
    (token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token),
  );
  const phrases = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const one = tokens[i];
    if (!STOPWORDS.has(one)) phrases.add(one);
    if (i + 1 < tokens.length) {
      const two = `${tokens[i]} ${tokens[i + 1]}`;
      if (!STOPWORDS.has(tokens[i]) && !STOPWORDS.has(tokens[i + 1])) phrases.add(two);
    }
    if (i + 2 < tokens.length) {
      const three = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      if (!STOPWORDS.has(tokens[i]) && !STOPWORDS.has(tokens[i + 1]) && !STOPWORDS.has(tokens[i + 2])) {
        phrases.add(three);
      }
    }
  }
  return [...phrases];
}

function normaliseForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value) {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function loadTopicTaxonomy() {
  let raw;
  try {
    raw = await readFile(TOPIC_TAXONOMY_PATH, "utf8");
  } catch {
    // A new vertical may not have a curated taxonomy yet — degrade gracefully so the
    // dashboard still builds (every question simply falls under "General").
    console.log(`No topic taxonomy at ${TOPIC_TAXONOMY_PATH}; using empty taxonomy.`);
    return { version: "none", concepts: [] };
  }
  const parsed = JSON.parse(raw);
  const concepts = (parsed.concepts || []).map((concept) => ({
    label: concept.label,
    aliases: (concept.aliases || []).map(normaliseForMatch).filter(Boolean),
  }));
  return {
    version: parsed.version || "unknown",
    concepts,
  };
}

function matchQuestionConcepts(normalisedText, taxonomy) {
  const hits = [];
  for (const concept of taxonomy.concepts) {
    if (concept.aliases.some((alias) => alias && normalisedText.includes(alias))) {
      hits.push(concept.label);
    }
  }
  return hits;
}

function buildMonthFingerprint(monthQuestions) {
  const canonical = monthQuestions
    .map((q) => `${q.id}|${q.uin}|${q.dateTabled}|${simpleHash(toTopicText(q))}`)
    .sort()
    .join("||");
  return simpleHash(canonical);
}

function previousMonths(month, orderedMonths, count) {
  const idx = orderedMonths.indexOf(month);
  if (idx <= 0) return [];
  return orderedMonths.slice(Math.max(0, idx - count), idx);
}

function computeMonthlyTopics(month, monthConceptCounts, monthTotals, orderedMonths) {
  const conceptCounts = monthConceptCounts.get(month) || new Map();
  const monthTotal = monthTotals.get(month) || 1;
  const trailingMonths = previousMonths(month, orderedMonths, TOPIC_WINDOW_MONTHS);

  const rows = [];
  for (const [label, count] of conceptCounts.entries()) {
    if (count < TOPIC_MIN_COUNT) continue;
    const volumeScore = count / monthTotal;

    let baselineAvg = 0;
    if (trailingMonths.length) {
      const trailingCounts = trailingMonths.map((m) => monthConceptCounts.get(m)?.get(label) || 0);
      baselineAvg = trailingCounts.reduce((sum, value) => sum + value, 0) / trailingCounts.length;
    }
    const spikeScore = (count + 1) / (baselineAvg + 1);
    const score = volumeScore * 0.6 + Math.log1p(spikeScore) * 0.4;

    rows.push({
      label,
      count,
      score: Number(score.toFixed(6)),
      volumeScore: Number(volumeScore.toFixed(6)),
      spikeScore: Number(spikeScore.toFixed(6)),
    });
  }

  return rows
    .sort((a, b) => b.score - a.score || b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, TOPIC_LIMIT);
}

// Decrypt an AES-256-GCM envelope produced by scripts/encrypt-data.mjs
// ({salt,iv,tag,data} base64 + PBKDF2 iterations). Mirrors the browser's deriveKey.
function decryptEnvelope(envelopeText, password) {
  const env = JSON.parse(envelopeText);
  const salt = Buffer.from(env.salt, "base64");
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const data = Buffer.from(env.data, "base64");
  const key = pbkdf2Sync(password, salt, env.iterations || 100_000, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// Read a vertical data file as text: prefer committed plaintext (local dev), else
// fall back to decrypting the committed `.enc` with PQ_PASSWORD. On CI only the
// encrypted files are committed, so without this the refresh can't see its own
// prior output and re-does a full fetch + full answer enrichment every run.
async function readVerticalJson(name) {
  try {
    return await readFile(path.join(verticalDir, name), "utf8");
  } catch {
    // no plaintext — try the encrypted sibling
  }
  const password = process.env.PQ_PASSWORD;
  if (!password) return null;
  try {
    const encText = await readFile(path.join(verticalDir, `${name}.enc`), "utf8");
    return decryptEnvelope(encText, password);
  } catch (error) {
    console.warn(`Could not read ${name} (plaintext or .enc): ${error.message}`);
    return null;
  }
}

async function loadPreviousSummary() {
  try {
    const payload = await readVerticalJson("summary.json");
    return payload ? JSON.parse(payload) : null;
  } catch {
    return null;
  }
}

function normaliseName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const [headers, ...dataRows] = rows;
  return dataRows
    .filter((cells) => cells.length && cells.some(Boolean))
    .map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""])),
    );
}

async function fetchJson(url, tries = 5) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      // Without a timeout a stalled socket hangs this await forever and the retry
      // logic below never runs — a long refresh can silently wedge on one bad
      // connection. Abort slow requests so they fall through to a retry instead.
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        error.status = response.status;
        error.retryAfterMs = (Number(response.headers.get("retry-after")) || 0) * 1000;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < tries) {
        // 429 (rate limited) needs a much longer backoff than transient errors
        const base = error.status === 429 ? 3000 : 800;
        const wait = error.retryAfterMs || base * attempt;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} from ${url}`);
  }
  return response.text();
}

async function loadPreviousQuestions() {
  try {
    const raw = await readVerticalJson("questions.json");
    return raw ? JSON.parse(raw).questions || [] : [];
  } catch {
    return [];
  }
}

function getNewestTabledDate(questions) {
  if (!questions.length) return "2014-06-04";
  let newest = questions[0].dateTabled || "2014-06-04";
  for (const q of questions) {
    if (q.dateTabled && q.dateTabled > newest) {
      newest = q.dateTabled;
    }
  }
  return newest;
}

function subtractDays(dateStr, days) {
  const date = new Date(dateStr);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

async function fetchQuestionsPaged(queryParams) {
  const all = [];
  let total = null;

  for (let skip = 0; total === null || skip < total; skip += PAGE_SIZE) {
    const params = new URLSearchParams({
      ...SOURCE_PARAMS,
      ...queryParams,
      take: String(PAGE_SIZE),
      skip: String(skip),
    });
    const url = `${QUESTIONS_ENDPOINT}?${params}`;
    const payload = await fetchJson(url);
    const pageItems = payload.results || [];

    total = Number(payload.totalResults || pageItems.length || 0);
    all.push(...pageItems);
    console.log(`Fetched ${all.length.toLocaleString()} / ${total.toLocaleString()} questions for params: ${JSON.stringify(queryParams)}`);

    if (!pageItems.length) {
      break;
    }
  }

  return all;
}

function getQuestion(item) {
  return item.value || item;
}

// The list endpoint truncates answerText to ~258 chars (ending in "...") and
// questionText to a hard 255-char cap. The full text is only available from the
// per-question detail endpoint, so we fetch it for rows that still look truncated.
function needsFullAnswer(q) {
  if (!q.answered || !q.id || q.answerFull) return false;
  const text = q.answerText || "";
  return !text || text.length >= 255 || /\.\.\.$/.test(text);
}

// A complete question always ends in sentence punctuation. The list endpoint caps
// questionText at 255 chars — 254 once stripHtml trims the trailing space — so the
// old `length >= 255` test never fired. Detect truncation by the missing full stop
// instead: anything not ending in . ? or ! was cut off and needs the detail
// endpoint's full text (what Parliament hides behind "show full question").
function needsFullQuestion(q) {
  if (!q.id || q.questionFull) return false;
  const text = (q.questionText || "").trim();
  if (!text) return false;
  return !/[.?!]["')\]]*$/.test(text);
}

async function enrichFullAnswers(questions) {
  const targets = questions.filter((q) => needsFullAnswer(q) || needsFullQuestion(q));
  if (!targets.length) {
    console.log("No answers need full-text enrichment.");
    return;
  }

  const concurrency = Number(process.env.ANSWER_CONCURRENCY || 8);
  const delayMs = Number(process.env.ANSWER_DELAY_MS || 0);
  console.log(
    `Fetching full answer text for ${targets.length.toLocaleString()} answered questions (concurrency ${concurrency}, delay ${delayMs}ms)...`,
  );

  let cursor = 0;
  let done = 0;
  let failed = 0;

  async function worker() {
    while (cursor < targets.length) {
      const q = targets[cursor];
      cursor += 1;
      try {
        const payload = await fetchJson(`${QUESTIONS_ENDPOINT}/${q.id}`);
        const detail = getQuestion(payload);
        const fullQuestion = stripHtml(detail.questionText);
        if (fullQuestion) {
          q.questionText = fullQuestion;
        }
        q.questionFull = true;
        const fullAnswer = stripHtml(detail.answerText);
        if (fullAnswer) {
          q.answerText = fullAnswer;
        }
        // Mark answers as fetched regardless of whether text came back — some
        // answered questions have no inline answer (holding answers, attachment-only),
        // and without this they would be re-fetched on every run forever. Only mark
        // answered rows, so a question answered later still gets its answer fetched.
        if (q.answered) {
          q.answerFull = true;
        }
      } catch {
        failed += 1;
      }
      done += 1;
      if (done % 250 === 0 || done === targets.length) {
        console.log(`  ...full answers ${done}/${targets.length} (${failed} failed)`);
      }
      if (delayMs) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(
    `Full answer enrichment complete: ${done - failed} updated, ${failed} failed.`,
  );
}

async function buildConstituencyLookup() {
  const cachePath = path.join(dataDir, "constituency-lookup-cache.json");
  const forceRebuild = process.argv.includes("--force");

  try {
    if (!forceRebuild) {
      const cacheRaw = await readFile(cachePath, "utf8");
      const cacheParsed = JSON.parse(cacheRaw);
      const lookupMap = new Map(Object.entries(cacheParsed.lookup));
      console.log(`Loaded ${cacheParsed.records.length} constituency mapping records from cache`);
      return { lookup: lookupMap, records: cacheParsed.records };
    }
  } catch (err) {
    console.log("Could not load constituency cache, rebuilding from CSVs...", err.message);
  }

  console.log("Fetching constituency CSVs from external sources...");
  const [csv2025, csv2020, overlapCsv] = await Promise.all([
    fetchText(CONSTITUENCY_CSV),
    fetchText(CONSTITUENCY_2020_CSV),
    fetchText(PARL10_TO_PARL25_CSV),
  ]);
  const rows = parseCsv(csv2025);
  const lookup = new Map();
  const byShortCode = new Map();
  const records = [];

  for (const row of rows) {
    const nation = row.nation || "Unknown";
    const region = row.region || "";
    const nhsRegion = DEVOLVED_NATIONS.has(nation)
      ? nation
      : NHS_REGION_BY_PARLIAMENT_REGION.get(normaliseName(region)) || "Unknown";
    const record = {
      name: row.name,
      shortCode: row.short_code,
      gssCode: row.gss_code,
      nation,
      parliamentaryRegion: region,
      nhsRegion,
      sourceBoundary: "2024",
    };

    records.push(record);
    byShortCode.set(row.short_code, record);
    lookup.set(normaliseName(row.name), record);
  }

  const overlapBy2010Code = new Map();
  for (const row of parseCsv(overlapCsv)) {
    const current = overlapBy2010Code.get(row.PARL10);
    const overlap = Number(row.percentage_overlap_pop || row.percentage_overlap_area || 0);
    if (!current || overlap > current.overlap) {
      overlapBy2010Code.set(row.PARL10, {
        targetCode: row.PARL25,
        overlap,
      });
    }
  }

  for (const row of parseCsv(csv2020)) {
    const name = row.PCON20NM;
    const target = overlapBy2010Code.get(row.PCON20CD);
    const mapped = target ? byShortCode.get(target.targetCode) : null;
    if (!name || !mapped) continue;

    lookup.set(normaliseName(name), {
      name,
      shortCode: row.PCON20CD,
      gssCode: row.PCON20CD,
      nation: mapped.nation,
      parliamentaryRegion: mapped.parliamentaryRegion,
      nhsRegion: mapped.nhsRegion,
      sourceBoundary: "2010 mapped to 2024",
      mappedToConstituency: mapped.name,
      mappedToShortCode: mapped.shortCode,
      overlap: target.overlap,
    });
  }

  // Save cache to disk
  try {
    await writeFile(
      cachePath,
      JSON.stringify({
        records,
        lookup: Object.fromEntries(lookup.entries())
      }, null, 2) + "\n",
      "utf8"
    );
    console.log("Saved constituency lookup cache to data/constituency-lookup-cache.json");
  } catch (err) {
    console.warn("Could not save constituency lookup cache:", err.message);
  }

  return { lookup, records };
}


function mapQuestion(item, constituencyLookup) {
  const q = getQuestion(item);
  const member = q.askingMember || {};
  const constituency = member.memberFrom || "";
  const regionRecord = constituencyLookup.get(normaliseName(constituency));
  const dateTabled = q.dateTabled ? q.dateTabled.slice(0, 10) : "";
  const dateAnswered = q.dateAnswered ? q.dateAnswered.slice(0, 10) : "";

  return {
    id: q.id,
    uin: q.uin,
    url: dateTabled && q.uin ? `${DETAIL_BASE}/${dateTabled}/${q.uin}` : "",
    heading: q.heading || "",
    questionText: stripHtml(q.questionText),
    answerText: stripHtml(q.answerText),
    dateTabled,
    dateAnswered,
    dateForAnswer: q.dateForAnswer ? q.dateForAnswer.slice(0, 10) : "",
    answered: Boolean(dateAnswered),
    answeringBodyName: q.answeringBodyName || "Department of Health and Social Care",
    isNamedDay: Boolean(q.isNamedDay),
    member: {
      id: member.id || null,
      name: member.name || "",
      party: member.party || "",
      partyAbbreviation: member.partyAbbreviation || "",
      constituency,
    },
    region: {
      constituency,
      nation: regionRecord?.nation || "Unknown",
      parliamentaryRegion: regionRecord?.parliamentaryRegion || "",
      nhsRegion: regionRecord?.nhsRegion || "Unknown",
      sourceBoundary: regionRecord?.sourceBoundary || "unmatched",
      mappedToConstituency: regionRecord?.mappedToConstituency || "",
    },
  };
}

function increment(map, key, amount = 1) {
  const cleanKey = key || "Unknown";
  map.set(cleanKey, (map.get(cleanKey) || 0) + amount);
}

function sortedCounts(map) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function buildSummary(
  questions,
  constituencyRecords,
  unmatchedConstituencies,
  taxonomy,
  previousSummary = null,
) {
  const partyCounts = new Map();
  const partyNames = new Map();
  const regionCounts = new Map();
  const memberCounts = new Map();
  const monthly = new Map();
  const monthQuestions = new Map();
  const monthConceptCounts = new Map();
  let answered = 0;

  for (const question of questions) {
    if (question.answered) answered += 1;

    const partyKey = question.member.partyAbbreviation || question.member.party || "Unknown";
    increment(partyCounts, partyKey);
    if (question.member.party) partyNames.set(partyKey, question.member.party);
    increment(regionCounts, question.region.nhsRegion);
    increment(memberCounts, question.member.name || "Unknown");

    const month = question.dateTabled ? question.dateTabled.slice(0, 7) : "Unknown";
    if (!monthly.has(month)) {
      monthly.set(month, {
        month,
        total: 0,
        answered: 0,
        unanswered: 0,
        byParty: {},
        byRegion: {},
      });
    }
    if (!monthQuestions.has(month)) monthQuestions.set(month, []);
    monthQuestions.get(month).push(question);
    const bucket = monthly.get(month);
    bucket.total += 1;
    bucket[question.answered ? "answered" : "unanswered"] += 1;
    bucket.byParty[partyKey] = (bucket.byParty[partyKey] || 0) + 1;
    bucket.byRegion[question.region.nhsRegion] =
      (bucket.byRegion[question.region.nhsRegion] || 0) + 1;
  }

  const dates = questions.map((question) => question.dateTabled).filter(Boolean).sort();
  const parties = sortedCounts(partyCounts).map((party) => ({
    ...party,
    name: partyNames.get(party.key) || party.key,
  }));
  const sortedMonthlyRows = [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month));
  const orderedMonths = sortedMonthlyRows.map((m) => m.month);

  for (const month of orderedMonths) {
    const counts = new Map();
    for (const q of monthQuestions.get(month) || []) {
      if (q.topic && q.topic !== "General") {
        counts.set(q.topic, (counts.get(q.topic) || 0) + 1);
      }
    }
    monthConceptCounts.set(month, counts);
  }

  const prevTopics = previousSummary?.topics || {};
  const prevFingerprints = prevTopics.monthFingerprints || {};
  const prevByMonth = prevTopics.byMonth || {};
  const prevMethodMatches =
    prevTopics.method === "taxonomy-plus-trends" && prevTopics.taxonomyVersion === taxonomy.version;
  const monthFingerprints = {};
  const byMonth = {};
  const monthTotals = new Map(sortedMonthlyRows.map((row) => [row.month, row.total]));

  for (const month of orderedMonths) {
    const fingerprint = buildMonthFingerprint(monthQuestions.get(month) || []);
    monthFingerprints[month] = fingerprint;
    const unchanged = prevMethodMatches && prevFingerprints[month] && prevFingerprints[month] === fingerprint;
    const previousRows = prevByMonth[month];
    const previousShapeValid =
      Array.isArray(previousRows) && previousRows.every((row) => typeof row?.label === "string");
    if (unchanged && previousShapeValid) {
      byMonth[month] = prevByMonth[month];
      continue;
    }
    byMonth[month] = computeMonthlyTopics(month, monthConceptCounts, monthTotals, orderedMonths);
  }

  return {
    generatedAt: new Date().toISOString(),
    source: {
      questionsEndpoint: QUESTIONS_ENDPOINT,
      constituencySource: CONSTITUENCY_CSV,
      historicConstituencySource: CONSTITUENCY_2020_CSV,
      constituencyOverlapSource: PARL10_TO_PARL25_CSV,
      params: SOURCE_PARAMS,
    },
    totals: {
      questions: questions.length,
      answered,
      unanswered: questions.length - answered,
      constituenciesInLookup: constituencyRecords.length,
      unmatchedConstituencies: unmatchedConstituencies.length,
    },
    dateRange: {
      oldestTabled: dates[0] || "",
      newestTabled: dates.at(-1) || "",
    },
    parties,
    regions: sortedCounts(regionCounts),
    topMembers: sortedCounts(memberCounts).slice(0, 20),
    monthly: sortedMonthlyRows,
    topics: {
      method: "taxonomy-plus-trends",
      taxonomyVersion: taxonomy.version,
      generatedAt: new Date().toISOString(),
      monthFingerprints,
      byMonth,
    },
    unmatchedConstituencies,
  };
}

function classifyQuestions(questions, taxonomy) {
  const tokenize = (text) => {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  };

  const df = new Map();
  const docTokens = questions.map((q) => {
    const headingTokens = tokenize(q.heading || "");
    const questionTokens = tokenize(q.questionText || "");
    const tokens = [...headingTokens, ...headingTokens, ...questionTokens];
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      df.set(token, (df.get(token) || 0) + 1);
    }
    return tokens;
  });

  const N = questions.length;
  const getIdf = (token) => {
    const count = df.get(token) || 0;
    if (count === 0) return 0;
    return Math.log(1 + N / count);
  };

  const conceptVectors = taxonomy.concepts.map((concept) => {
    const labelTokens = tokenize(concept.label);
    const aliasTokens = (concept.aliases || []).flatMap((alias) => tokenize(alias));
    const termWeights = new Map();
    for (const t of labelTokens) {
      termWeights.set(t, (termWeights.get(t) || 0) + 3.0);
    }
    for (const t of aliasTokens) {
      termWeights.set(t, (termWeights.get(t) || 0) + 1.0);
    }

    const vector = new Map();
    let magnitudeSq = 0;
    for (const [term, weight] of termWeights.entries()) {
      const idf = getIdf(term);
      if (idf > 0) {
        const val = weight * idf;
        vector.set(term, val);
        magnitudeSq += val * val;
      }
    }

    return {
      label: concept.label,
      vector,
      magnitude: Math.sqrt(magnitudeSq),
    };
  });

  questions.forEach((q, idx) => {
    const tokens = docTokens[idx];
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    const qVector = new Map();
    let qMagnitudeSq = 0;
    for (const [term, count] of tf.entries()) {
      const idf = getIdf(term);
      if (idf > 0) {
        const val = count * idf;
        qVector.set(term, val);
        qMagnitudeSq += val * val;
      }
    }
    const qMagnitude = Math.sqrt(qMagnitudeSq);

    let bestLabel = "General";
    let bestScore = 0;

    if (qMagnitude > 0) {
      for (const concept of conceptVectors) {
        if (concept.magnitude === 0) continue;
        let dotProduct = 0;
        for (const [term, val] of qVector.entries()) {
          const conceptVal = concept.vector.get(term) || 0;
          dotProduct += val * conceptVal;
        }
        const score = dotProduct / (qMagnitude * concept.magnitude);
        if (score > bestScore) {
          bestScore = score;
          bestLabel = concept.label;
        }
      }
    }

    q.topic = bestScore >= 0.03 ? bestLabel : "General";
  });
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(verticalDir, { recursive: true });

  // --enrich-only: skip the (rate-limit-prone) list fetch and just backfill full
  // answer text into the existing questions.json. Idempotent — only touches answers
  // still marked truncated, so it can be re-run until everything is enriched.
  if (process.argv.includes("--enrich-only")) {
    const existing = await loadPreviousQuestions();
    if (!existing.length) {
      console.log("Enrich-only: no existing questions.json found, nothing to do.");
      return;
    }
    console.log(`Enrich-only mode: loaded ${existing.length.toLocaleString()} questions.`);
    await enrichFullAnswers(existing);
    await writeFile(
      path.join(verticalDir, "questions.json"),
      `${JSON.stringify({ questions: existing })}\n`,
      "utf8",
    );
    console.log("Enrich-only complete: questions.json updated.");
    return;
  }

  const taxonomy = await loadTopicTaxonomy();
  const { lookup, records: constituencyRecords } = await buildConstituencyLookup();

  const existingQuestions = await loadPreviousQuestions();
  const forceFull = process.argv.includes("--full");
  const isOffline = process.argv.includes("--offline");

  let questions;
  if (isOffline) {
    console.log("Running in offline mode. Rebuilding from existing questions only (no API fetch)...");
    questions = existingQuestions;
  } else if (existingQuestions.length && !forceFull) {
    const newestDate = getNewestTabledDate(existingQuestions);
    const startDate = subtractDays(newestDate, 60);
    console.log(`Performing incremental fetch since ${startDate} (based on newest question date ${newestDate} - 60 days)`);

    const tabledPromise = fetchQuestionsPaged({ tabledWhenFrom: startDate });
    const answeredPromise = fetchQuestionsPaged({ answeredWhenFrom: startDate });

    const [tabledResult, answeredResult] = await Promise.all([tabledPromise, answeredPromise]);

    const newQuestionsMap = new Map();
    for (const item of [...tabledResult, ...answeredResult]) {
      const q = getQuestion(item);
      if (q && q.id) {
        newQuestionsMap.set(q.id, item);
      }
    }
    const fetchedRawItems = [...newQuestionsMap.values()];
    console.log(`Fetched ${fetchedRawItems.length} unique raw questions in window`);

    const processedNewQuestions = fetchedRawItems
      .map((item) => mapQuestion(item, lookup))
      .filter(matchesVertical);

    const mergedMap = new Map();
    for (const q of existingQuestions) {
      mergedMap.set(q.id, q);
    }
    for (const q of processedNewQuestions) {
      // Freshly mapped questions only carry the list endpoint's truncated answerText
      // (no answerFull). If we already have the full answer for an unchanged question,
      // carry it forward so we don't needlessly re-fetch the whole window every run.
      // The truncated snippet is a prefix of the full answer, so a prefix match means
      // the answer is unchanged; a mismatch (amended answer) correctly falls through to
      // re-enrichment.
      const prior = mergedMap.get(q.id);
      if (prior && prior.answerFull && !q.answerFull && prior.answerText) {
        const snippet = (q.answerText || "").replace(/\.\.\.$/, "");
        if (snippet && prior.answerText.startsWith(snippet)) {
          q.answerText = prior.answerText;
          q.answerFull = true;
        }
      }
      // Same for question text, which the list endpoint hard-caps at 255 chars.
      if (prior && prior.questionFull && !q.questionFull && prior.questionText) {
        const qSnippet = q.questionText || "";
        if (qSnippet && prior.questionText.startsWith(qSnippet)) {
          q.questionText = prior.questionText;
          q.questionFull = true;
        }
      }
      mergedMap.set(q.id, q);
    }

    questions = [...mergedMap.values()];
    console.log(`Merged incremental PQs. Total: ${questions.length} questions`);
  } else {
    console.log("Performing full fetch of all questions from API...");
    const rawQuestions = await fetchQuestionsPaged({});
    questions = rawQuestions
      .map((item) => mapQuestion(item, lookup))
      .filter(matchesVertical);
    console.log("Full fetch complete. Total: " + questions.length + " questions");
  }

  // Only Written Questions API data (questions-statements-api.parliament.uk) is used.
  questions.sort((a, b) => {
    const dateCompare = b.dateTabled.localeCompare(a.dateTabled);
    if (dateCompare) return dateCompare;
    return String(b.uin || "").localeCompare(String(a.uin || ""));
  });

  if (!isOffline) {
    await enrichFullAnswers(questions);
  } else {
    console.log("Offline mode: skipping live answer enrichment.");
  }

  classifyQuestions(questions, taxonomy);

  const unmatchedConstituencies = [
    ...new Set(
      questions
        .filter((question) => question.region.nhsRegion === "Unknown")
        .map((question) => question.member.constituency)
        .filter(Boolean),
    ),
  ].sort();

  const previousSummary = await loadPreviousSummary();
  const summary = buildSummary(
    questions,
    constituencyRecords,
    unmatchedConstituencies,
    taxonomy,
    previousSummary,
  );

  await writeFile(
    path.join(verticalDir, "questions.json"),
    `${JSON.stringify({ questions })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(verticalDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(dataDir, "constituency-regions.json"),
    `${JSON.stringify({ generatedAt: summary.generatedAt, source: CONSTITUENCY_CSV, constituencies: constituencyRecords }, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `Wrote ${questions.length.toLocaleString()} questions, ${summary.dateRange.oldestTabled} to ${summary.dateRange.newestTabled}`,
  );
  if (unmatchedConstituencies.length) {
    console.log(`Unmatched constituencies: ${unmatchedConstituencies.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
