/**
 * Invoice Extractor - Google Apps Script
 * --------------------------------------
 * Reads every PDF / image in a Google Drive folder, uses an LLM (Gemini or
 * Claude) to extract invoice details, and writes them to a Google Sheet
 * named "Invoice_Details" inside the same folder.
 *
 * Re-runnable: rows already in the sheet (matched by File_Name) are skipped,
 * so new invoices dropped into the folder get appended on the next run.
 *
 * ============================ SETUP (one time) ============================
 * 1. Go to https://script.google.com  ->  New project
 * 2. Paste this entire file in as Code.gs (replacing the default)
 * 3. Set your folder ID in CONFIG below
 *      - Open your Drive folder in the browser
 *      - URL looks like https://drive.google.com/drive/folders/<FOLDER_ID>
 *      - Copy <FOLDER_ID> into CONFIG.FOLDER_ID
 * 4. Pick your provider in CONFIG.LLM_PROVIDER ('gemini' or 'claude')
 * 5. Add your API key as a Script Property (keeps it out of the code):
 *      - File icon (gear) -> Project Settings -> Script Properties
 *      - Add property:  GEMINI_API_KEY  (or CLAUDE_API_KEY)
 *      - Get a Gemini key: https://aistudio.google.com/apikey
 *      - Get a Claude key: https://console.anthropic.com/settings/keys
 * 6. Save, then click Run on extractInvoices().  Approve the OAuth prompt
 *    the first time (Drive + Sheets + external URL access).
 *
 * To re-run later: just click Run again.  Or set a time-based trigger
 * (clock icon) to run extractInvoices on a schedule.
 * =========================================================================
 */

// =============================== CONFIG ==================================
const CONFIG = {
  // Drive folder containing the invoices.  Copy from the folder URL.
  FOLDER_ID: '1-_Umkkkjphfxe49J_CbbMiy7DetcB1u8',

  // 'gemini' or 'claude'
  LLM_PROVIDER: 'claude',

  // Model names - change if you want a different tier
  GEMINI_MODEL: 'gemini-2.5-flash',
  CLAUDE_MODEL: 'claude-sonnet-4-6',

  // Output sheet name (created in the same folder if it doesn't exist)
  SHEET_NAME: 'Invoice_Details',

  // If true, files already in the sheet are skipped on re-run
  SKIP_PROCESSED: true,

  // -------- Classification + filing (Step 2) --------
  // Policy file lives in the root folder. Supported: Policy.txt, Policy.md, Policy.pdf
  POLICY_BASENAME: 'Policy',
  // Itinerary PDFs / text files live in this subfolder
  ITINERARY_SUBFOLDER: 'Itinerary',
  // Subfolders that classified invoices get moved into
  ALLOWED_SUBFOLDER: 'Allowed',
  NOT_ALLOWED_SUBFOLDER: 'Not_Allowed',
  REVIEW_SUBFOLDER: 'Needs_Review',
  // If true, classifyInvoices() re-runs on rows that already have a Classification
  RECLASSIFY_ALL: false,
};
// =========================================================================

const HEADERS = [
  'File_Name', 'File_Link', 'Date', 'Date_Raw', 'Currency', 'Amount',
  'Vendor Name', 'City', 'Country', 'Invoice Description', 'Detailed_Description',
  'Classification', 'Classification_Reason',
];

/** Extract -> classify -> move, in one shot. */
function runAll() {
  extractInvoices();
  classifyInvoices();
  moveClassifiedFiles();
}

/**
 * Container-bound only: builds an "Invoice Tools" menu in the Sheet's menu
 * bar when the Sheet opens. Has no effect in standalone mode (SpreadsheetApp.getUi()
 * throws there, so we swallow the error).
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Invoice Tools')
      .addItem('Extract invoices',           'extractInvoices')
      .addItem('Classify invoices',          'classifyInvoices')
      .addItem('Move + rename files',        'moveClassifiedFiles')
      .addSeparator()
      .addItem('Run all (extract → classify → move)', 'runAll')
      .addSeparator()
      .addItem('Debug: dump resolved itinerary',      'dumpResolvedItinerary')
      .addToUi();
  } catch (e) {
    // Standalone mode - no UI context, ignore.
  }
}

// =========================================================================
// Shared Utilities
// =========================================================================


function getOrCreateSheet(folder) {
  // Container-bound mode: if this script is attached to a Sheet, use it.
  // Standalone mode: getActiveSpreadsheet() returns null, so fall back to
  // finding (or creating) the sheet by name inside the invoices folder.
  let ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    const existing = folder.getFilesByName(CONFIG.SHEET_NAME);
    if (existing.hasNext()) {
      ss = SpreadsheetApp.open(existing.next());
    } else {
      ss = SpreadsheetApp.create(CONFIG.SHEET_NAME);
      const ssFile = DriveApp.getFileById(ss.getId());
      folder.addFile(ssFile);
      DriveApp.getRootFolder().removeFile(ssFile);
    }
  }
  const sheet = ss.getSheets()[0];
  const cur = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (cur.join('|') !== HEADERS.join('|')) {
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}


function normalizeClass(s) {
  if (!s) return '';
  const t = String(s).trim().toLowerCase();
  if (t.startsWith('allow'))      return 'Allowed';
  if (t.startsWith('not'))        return 'Not Allowed';
  if (t.startsWith('needs') || t.startsWith('review')) return 'Needs Review';
  return '';
}

function stripFences(s) {
  return String(s).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}
