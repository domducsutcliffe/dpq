// ─────────────────────────────────────────────────────────────────────────────
// VERTICAL CONFIG — the single source of truth for what this dashboard tracks.
//
// Both the browser app (scripts/app.js) and the data refresh (scripts/refresh-data.mjs)
// import this file, so the "root" of the search lives in exactly one place: the
// API search terms, the post-fetch keyword filter, the branding, and the plain-English
// term list in the orange top bar all come from here.
//
// The dataset is rebuilt with:  node scripts/refresh-data.mjs
// (per-vertical output lives in data/<id>/; geography files are shared at data/)
// ─────────────────────────────────────────────────────────────────────────────

export const VERTICALS = [
  {
    id: "dentistry",
    // Lowercase noun used inline in sentences, e.g. "questions mentioning dentistry".
    topic: "dentistry and water fluoridation",
    // Shown as the page <title>, the top-bar brand, and the switcher label.
    brandTitle: "Dentistry PQ Dashboard",
    label: "Dentistry",

    // --- UK Parliament Written Questions API scope ---
    house: "Commons",
    answeringBodies: "17", // 17 = Department of Health and Social Care
    answeringBodyLabel: "DHSC",
    // Fetch each API search term separately and combine the results by question ID.
    // fluorid* catches fluoride, fluoridation and fluoridated water.
    searchTerms: ["dent*", "fluorid*"],

    // Word-boundary roots used to post-filter a question's heading/text after fetch
    // (case-insensitive). Keep consistent with searchTerms; add roots to widen scope.
    matchRoots: ["dent", "fluorid"],

    // Plain-English list of what the scope catches — surfaced in the orange top bar.
    plainEnglishTerms: ["dentist", "dental", "dentistry", "denture", "fluoridation", "fluoride", "fluoridated water"],
  },
];

export const DEFAULT_VERTICAL_ID = "dentistry";

// Resolve a vertical by id, falling back to the default (and finally the first entry).
export function getVertical(id) {
  return (
    VERTICALS.find((v) => v.id === id) ||
    VERTICALS.find((v) => v.id === DEFAULT_VERTICAL_ID) ||
    VERTICALS[0]
  );
}
