const EXTRACTION_PROMPT = `You are an invoice data extractor. Analyze the attached invoice (PDF or photo) and return ONLY a JSON object - no markdown fences, no commentary.

If the image is rotated 90/180/270 degrees, mentally rotate it upright before reading. Receipts are often photographed sideways.

Extract these fields:

- date_raw: copy the date verbatim from the receipt, exactly as printed (e.g. "05/04/2026", "23 Apr 2026", "5 mars 2025"). If the receipt has multiple dates (invoice date, due date, check-in, check-out, booking date, travel date), pick the TRANSACTION date - the one printed near the total or labelled "Date:", "Sale Date", "Transaction Date". For hotel folios use check-out. For flights use travel date, not booking date. Empty string if no date is readable.
  CRITICAL - do NOT confuse the following with the transaction date:
    * Order ID / Order # / Receipt # / Transaction ID / Auth Code / Invoice # (these are sequence numbers, often 6-10 digits)
    * Phone numbers, VAT numbers, postcodes, street addresses
    * Times of day (09:03 PM is not a month)
    * Table numbers, customer IDs
  When in doubt about whether a number is a date, look for the literal word "Date" / "Dated" / month names (Jan, Feb, ...) / separators (/ - .) typical of a date. There are no future dated invoices or invoices older than 1 year from current date.

- date: the same date converted to ISO YYYY-MM-DD. Use country/locale to disambiguate DD/MM vs MM/DD:
    * United States, Canada -> MM/DD/YYYY
    * UK, EU, India, Australia, most of the world -> DD/MM/YYYY
  Two-digit year -> assume 2000s. If you cannot confidently read the year, return empty string - do NOT guess. There are no future dated invoices or invoices older than 1 year from current date.

- country: 2-letter ISO country code for where the transaction happened (US, GB, IN, FR, DE, ...). Infer from address, postcode, currency, language, "USA"/"UK" suffixes. Empty string if truly unknown.

- currency: 3-letter ISO code. Convert symbols: $ -> USD, € -> EUR, £ -> GBP, ¥ -> JPY, ₹ -> INR. Empty string if unknown.

- amount: final total as a number (no currency symbol, no thousands separators). Use grand total / amount paid. NOT subtotal.

- vendor_name: merchant or business name as printed.

- city: the actual city of the transaction (e.g. "Garden Grove", "Hounslow", "Milan"). State/region names like "California" or "Karnataka" are NOT cities. If the address shows "12549 Harbor Blvd, Garden Grove, California, USA" the city is "Garden Grove". Empty string if not present.

- description: short natural-language line, e.g. "Euro 5 for Coffee in Vegas", "$20 for lunch in Austin", "$35 for extra baggage on Atlanta to Austin flight", "GBP 25 for Uber from Heathrow Airport to Hotel". Use the currency word or symbol (whichever reads naturally), the amount, what was purchased, and the city when known.

- detailed_description: a richer one-line version of description. Include every relevant detail visible on the invoice: specific venue / pickup / dropoff names, neighbourhood or landmark, time of day, and the date written naturally (e.g. "3rd Oct"). Examples:
    * "$39 for Uber ride in Atlanta from Holiday Inn Express Airport North hotel to Hartsfield Jackson airport at 7 am on 3rd Oct"
    * "GBP 25 for lunch at The Mango at London Heathrow airport at 3 pm on 5th Feb"
    * "Euro 12 for coffee and pastry at Cafe Centrale, Piazza del Duomo, Milan at 9 am on 14th Mar"
  For ANY food or beverage bill (restaurant, cafe, bar, hotel dining, room service, in-flight meals, etc.) you MUST explicitly state whether alcoholic drinks were included. Inspect the line items: beer, wine, spirits, cocktails, champagne, prosecco, sake, soju, "bar" charges, etc. count as alcoholic. End the food/drink detailed_description with either ", including alcoholic drinks" or ", no alcoholic drinks". If the bill is not food/beverage, do not add that suffix. Omit any detail (time, address, etc.) that is not actually on the invoice instead of guessing.

ANTI-HALLUCINATION: if any field cannot be read with high confidence, return an empty string for THAT field. Never fabricate a date, amount, or city by pattern-matching on nearby digits (like Order IDs or Auth Codes). It is better to leave a field blank than to invent it.

Output schema (exact keys):
{"date_raw":"","date":"YYYY-MM-DD","country":"XX","currency":"XXX","amount":0.00,"vendor_name":"","city":"","description":"","detailed_description":""}`;

/** Main entry point - click Run on this function. */
function extractInvoices() {
  if (CONFIG.FOLDER_ID === 'PASTE_FOLDER_ID_HERE') {
    throw new Error('Set CONFIG.FOLDER_ID to your Drive folder ID first.');
  }
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const sheet = getOrCreateSheet(folder);
  const seen = CONFIG.SKIP_PROCESSED ? readExistingFileNames(sheet) : new Set();

  const files = listInvoiceFiles(folder);
  Logger.log(`Folder: ${folder.getName()} | files found: ${files.length} | already in sheet: ${seen.size}`);

  let ok = 0, fail = 0, skip = 0;
  for (const file of files) {
    const name = file.getName();
    if (seen.has(name)) { skip++; continue; }
    try {
      Logger.log(`Extracting: ${name}`);
      const d = extractFromFile(file);
      sheet.appendRow([
        name,
        file.getUrl(),
        d.date || '',
        d.date_raw || '',
        d.currency || '',
        (d.amount === 0 || d.amount) ? d.amount : '',
        d.vendor_name || '',
        d.city || '',
        d.country || '',
        d.description || '',
        d.detailed_description || '',
      ]);
      SpreadsheetApp.flush();
      ok++;
    } catch (e) {
      Logger.log(`FAILED ${name}: ${e.message}`);
      sheet.appendRow([name, file.getUrl(), '', '', '', '', '', '', '', `ERROR: ${e.message}`, '']);
      fail++;
    }
  }
  Logger.log(`Done. extracted=${ok}  failed=${fail}  skipped=${skip}`);
}

function listInvoiceFiles(folder) {
  const allowed = new Set([
    'application/pdf',
    'image/jpeg', 'image/jpg', 'image/png',
    'image/webp', 'image/heic', 'image/heif',
  ]);
  const out = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (allowed.has(f.getMimeType())) out.push(f);
  }
  return out;
}

function readExistingFileNames(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return new Set();
  const col = sheet.getRange(2, 1, last - 1, 1).getValues().flat();
  return new Set(col.filter(Boolean));
}

function extractFromFile(file) {
  const blob = file.getBlob();
  const mime = file.getMimeType();
  const b64 = Utilities.base64Encode(blob.getBytes());

  const raw = CONFIG.LLM_PROVIDER === 'claude'
    ? callClaude(b64, mime)
    : callGemini(b64, mime);

  // Strip ```json fences if the model added them anyway
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return normalizeExtracted(JSON.parse(cleaned));
}

/**
 * Validate / clean fields returned by the LLM.
 * - date arrives as YYYY-MM-DD. Verify format, valid calendar day,
 *   not in the future. On any failure, blank it (rather than write garbage).
 * - country is upper-cased and trimmed to 2 chars.
 */
function normalizeExtracted(d) {
  d = d || {};
  if (d.date) {
    const ymd = String(d.date).trim();
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    let ok = false;
    if (m) {
      const y = +m[1], mo = +m[2], da = +m[3];
      const dt = new Date(y, mo - 1, da);
      const calOk = dt.getFullYear() === y && dt.getMonth() + 1 === mo && dt.getDate() === da;
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      const notFuture = dt <= tomorrow;
      const inRange = y >= 2020 && y <= tomorrow.getFullYear() + 1;
      ok = calOk && notFuture && inRange;
      if (ok) d.date = ymd;  // keep YYYY-MM-DD as-is
    }
    if (!ok) {
      Logger.log(`Date validation failed. raw='${d.date_raw || ''}' parsed='${ymd}' -> blanking.`);
      d.date = '';
    }
  }
  if (d.country) d.country = String(d.country).trim().toUpperCase().slice(0, 2);
  return d;
}

function callGemini(b64, mime) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY missing in Script Properties');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const payload = {
    contents: [{
      parts: [
        { text: EXTRACTION_PROMPT },
        { inline_data: { mime_type: mime, data: b64 } },
      ],
    }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0,
    },
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Gemini ${res.getResponseCode()}: ${res.getContentText().slice(0, 500)}`);
  }
  return JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
}

function callClaude(b64, mime) {
  const key = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!key) throw new Error('CLAUDE_API_KEY missing in Script Properties');
  const isPdf = mime === 'application/pdf';
  // Claude doesn't accept HEIC; convert/skip if needed
  if (!isPdf && (mime === 'image/heic' || mime === 'image/heif')) {
    throw new Error('Claude API does not accept HEIC/HEIF. Convert to JPEG/PNG or switch CONFIG.LLM_PROVIDER to "gemini".');
  }
  const mediaBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mime,             data: b64 } };
  const payload = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [mediaBlock, { type: 'text', text: EXTRACTION_PROMPT }],
    }],
  };
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Claude ${res.getResponseCode()}: ${res.getContentText().slice(0, 500)}`);
  }
  return JSON.parse(res.getContentText()).content[0].text;
}
