# Travel Invoices Classifier

A Google Apps Script project that turns a folder of travel-invoice PDFs and phone photos into a structured Google Sheet, classifies each expense against a written company policy + your trip itinerary, and files the originals into `Allowed` / `Not_Allowed` / `Needs_Review` subfolders with cleanly renamed filenames.

Uses Gemini or Claude (your choice, your API key) for the LLM calls.

## What it does

1. **Extract** — for every PDF / image in a Drive folder, calls the LLM to pull out date, currency, amount, vendor, city, country, and a natural-language description. Writes everything to a Google Sheet called `Invoice_Details` in the same folder.
2. **Classify** — reads a `Policy.txt` and any itinerary files (PDFs, text, Google Docs) from the folder, then asks the LLM to judge each invoice as `Allowed`, `Not Allowed`, or `Needs Review`, with a one-sentence reason citing the policy clause or itinerary fact.
3. **Move + rename** — physically moves each invoice into the matching subfolder and renames it to `YYYYMMDD_CCY_Amount_Vendor.ext` (e.g. `20260423_GBP_18_Giraffe Heathrow T3.jpg`) for easy human review.

All three steps are independent functions, so you can pause between them to sanity-check the sheet before files get moved.

## Folder layout

```
<your invoice folder>/
├── Policy.txt              ← edit with your company's expense rules
├── Itinerary/              ← drop trip PDFs / Google Docs here
│   ├── flights.pdf
│   └── trip-notes  (a Google Doc with Perk / TripIt links)
├── Invoice_Details         ← the output sheet (auto-created)
├── Itinerary_Resolved      ← optional debug doc (auto-created on demand)
├── Allowed/                ← auto-created on first move
├── Not_Allowed/            ← auto-created on first move
├── Needs_Review/           ← auto-created on first move
└── <your invoices>         ← drop PDFs and phone photos here
```

## Setup (one time)

1. Go to <https://script.google.com> → New project.
2. Create four script files matching this repo and paste in `Config.gs`, `Extraction.gs`, `Classification.gs`, `MoveFiles.gs`.
3. In `Config.gs`, set:
   - `FOLDER_ID` — from the Drive URL `https://drive.google.com/drive/folders/<FOLDER_ID>`.
   - `LLM_PROVIDER` — `'gemini'` or `'claude'`.
4. Project Settings (gear icon) → Script Properties → add either `GEMINI_API_KEY` or `CLAUDE_API_KEY`.
   - Gemini key: <https://aistudio.google.com/apikey>
   - Claude key: <https://console.anthropic.com/settings/keys>
5. Run `extractInvoices` once and approve the OAuth scopes (Drive, Sheets, Docs, External URL).

## Day-to-day use

Drop new invoices into the folder, then in the Apps Script editor run one of:

- `extractInvoices` — fills in sheet rows for any files not already in it.
- `classifyInvoices` — fills in `Classification` + `Classification_Reason` for rows that don't yet have a verdict.
- `moveClassifiedFiles` — moves + renames files according to the sheet.
- `runAll` — extract → classify → move, in one click.
- `dumpResolvedItinerary` — writes a `Itinerary_Resolved` Google Doc showing exactly what itinerary text reaches the LLM (with every URL in your itinerary expanded via Jina Reader). Useful for debugging classification quality.

## Sheet schema (`Invoice_Details`)

| Column | Notes |
|---|---|
| `File_Name` | Updated after rename so the next run can still find the file. |
| `File_Link` | Direct Drive URL to the invoice. |
| `Date` | Transaction date in `YYYY-MM-DD`. Blanked if the model couldn't read it confidently. |
| `Date_Raw` | Verbatim date string as printed on the receipt — debug aid for the `Date` column. |
| `Currency` | 3-letter ISO code. |
| `Amount` | Grand total as a number. |
| `Vendor Name` | Merchant name. |
| `City` | Transaction city (e.g. `Garden Grove`, not `California`). |
| `Country` | 2-letter ISO code. |
| `Invoice Description` | Short natural-language summary. |
| `Detailed_Description` | Richer summary with venue, time, items. Food/drink rows are tagged `including alcoholic drinks` or `no alcoholic drinks`. |
| `Classification` | `Allowed` / `Not Allowed` / `Needs Review`. |
| `Classification_Reason` | One-sentence justification citing the policy or itinerary. |

## Configuration knobs (`Config.gs`)

| Setting | Default | Purpose |
|---|---|---|
| `SKIP_PROCESSED` | `true` | Skip files already in the sheet on re-extraction. |
| `RECLASSIFY_ALL` | `false` | When `true`, classify overwrites rows that already have a verdict — useful after editing `Policy.txt`. |
| `POLICY_BASENAME` | `Policy` | Looked up as `Policy.txt`, `Policy.md`, `Policy.pdf`, or a Google Doc named `Policy`. |
| `ITINERARY_SUBFOLDER` | `Itinerary` | Subfolder scanned for trip files. |
| `ALLOWED_SUBFOLDER` / `NOT_ALLOWED_SUBFOLDER` / `REVIEW_SUBFOLDER` | `Allowed` / `Not_Allowed` / `Needs_Review` | Where files land after classification. |
| `GEMINI_MODEL` / `CLAUDE_MODEL` | `gemini-2.5-flash` / `claude-sonnet-4-5` | Bump up for harder receipts. |

## Itinerary tips

- Plain PDFs (flights, hotel confirmations) work directly.
- A Google Doc with a list of trip-management URLs (Perk, TripIt, etc.) also works — link contents get fetched via Jina Reader (`r.jina.ai`) and inlined as text before the LLM call.
- Always include the year somewhere in the doc. Many trip-share pages render dates as "Mon 9 Feb" with no year, which forces the LLM to guess.
- Run `dumpResolvedItinerary` after editing to confirm every URL was fetched successfully (the doc shows per-file `fetched OK` vs `failed` counts).

## File naming on move

`<YYYYMMDD>_<CCY>_<Amount>_<Vendor>.<ext>`

Examples:

- `20260423_GBP_18_Giraffe Heathrow T3.jpg`
- `20260504_USD_82.38_URBAN PUNJAB.jpg`
- `20260512_INR_524_HMSHost Services India Pvt Ltd.jpg`

If any of `Date` / `Currency` / `Amount` / `Vendor Name` is missing, the rename is skipped (the file still moves under its original name). Collisions get `_2`, `_3`, … suffixes.

## Sharing with colleagues

In the Apps Script editor: Share → Anyone with link → Viewer. Each colleague clicks **Make a copy**, sets their own `FOLDER_ID`, adds their own API key in Script Properties, drops a `Policy.txt` and itinerary in their folder. Same code path, isolated data and keys.

## Troubleshooting

- **`renamed=0` after a move** — usually means `Date` / `Currency` / `Amount` / `Vendor Name` is blank on every row. Check the sheet.
- **Wrong date extracted** — compare `Date` vs `Date_Raw`. If `Date_Raw` is also wrong, the photo is illegible or rotated badly. If `Date_Raw` is right but `Date` is wrong, the locale disambiguation got it (e.g. `05/04` could be May 4 or Apr 5); add `Country` to the receipt's region or extend `Policy.txt` with a hint.
- **`Date_Raw` shows pattern from Order ID / Auth Code** — the prompt already calls these out; if it keeps happening, switch `LLM_PROVIDER` to the heavier model (`gemini-2.5-pro` or Claude Sonnet) for that row.
- **Jina link scraping silently failing** — run `dumpResolvedItinerary` and grep for `JINA FAILED` in the resulting doc.
- **HEIC photos failing on Claude** — Claude's image API doesn't accept HEIC. Either convert to JPEG before upload, or switch `LLM_PROVIDER` to `'gemini'`.

## File-by-file

| File | What's inside |
|---|---|
| `Config.gs` | Shared `CONFIG`, `HEADERS`, `runAll()`, sheet helpers (`getOrCreateSheet`, `normalizeClass`, `stripFences`). |
| `Extraction.gs` | `extractInvoices`, the extraction prompt, LLM calls (`callGemini` / `callClaude`), and `normalizeExtracted` for date validation. |
| `Classification.gs` | `classifyInvoices`, `dumpResolvedItinerary`, policy + itinerary loaders, `extractLinksToMarkdown`, and the classification LLM calls. |
| `MoveFiles.gs` | `moveClassifiedFiles`, filename builder, collision handling, folder helpers. |
