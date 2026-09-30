// ─────────────────────────────────────────────────────────────────────────────
// VERTICAL CONFIG — the single source of truth for what this dashboard tracks.
//
// Both the browser app (scripts/app.js) and the data refresh (scripts/refresh-data.mjs)
// import this file, so the "root" of the search lives in exactly one place: the
// API search terms, the post-fetch keyword filter, the branding, and the plain-English
// term list in the footer all come from here.
//
// The dataset is rebuilt with:  node scripts/refresh-data.mjs
// (per-vertical output lives in data/<id>/; geography files are shared at data/)
// ─────────────────────────────────────────────────────────────────────────────

export const VERTICALS = [
  {
    id: "dentistry",
    // Lowercase noun used inline in sentences, e.g. "questions mentioning dentistry".
    topic: "dentistry, oral health and water fluoridation",
    // Shown as the page <title>, the top-bar brand, and the switcher label.
    brandTitle: "Dentistry PQs",
    label: "Dentistry",

    // --- UK Parliament Written Questions API scope ---
    houses: ["Commons", "Lords"],
    answeringBodies: "17", // 17 = Department of Health and Social Care
    answeringBodyLabel: "DHSC",
    // Fetch each API search term separately and combine the results by question ID.
    // Wildcards include related forms; peridont* also covers the common misspelling.
    searchTerms: ["dent*", "fluorid*", "periodont*", "peridont*", "gingiv*", "oral health", "oral hygiene", "tooth*", "teeth", "caries", "gum disease", "orthodont*", "endodont*", "maxillofacial", "oral cancer", "mouth cancer", "root canal"],

    // Word-boundary roots used to post-filter a question's heading/text after fetch
    // (case-insensitive). Keep consistent with searchTerms; add roots to widen scope.
    matchRoots: ["dent", "fluorid", "periodont", "peridont", "gingiv", "oral[\\s-]+health", "oral[\\s-]+hygiene", "tooth", "teeth", "caries", "gum[\\s-]+disease", "orthodont", "endodont", "maxillofacial", "oral[\\s-]+cancer", "mouth[\\s-]+cancer", "root[\\s-]+canal"],

    // Plain-English scope description, shown in the footer.
    plainEnglishTerms: ["dentistry", "fluoridation", "periodontitis", "periodontal disease", "gingivitis", "oral health", "oral hygiene", "tooth decay", "toothache", "teeth", "caries", "gum disease", "orthodontics", "endodontics", "maxillofacial surgery", "oral cancer", "mouth cancer", "root canals"],
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
