/**
 * File 3: Classification.gs
 * Handles reading the policy and itinerary, and asking the LLM to audit
 * the extracted rows in the Google Sheet.
 */

const CLASSIFICATION_PROMPT = `You are a corporate expense auditor. You receive:
  1. The company's expense policy (text).
  2. The employee's travel itinerary (one or more PDFs / text).
  3. A JSON array of invoice rows already extracted from receipts.

For EACH invoice, output exactly one of:
  - "Allowed"     : clearly satisfies the policy AND falls inside the itinerary (dates, cities, purpose).
  - "Not Allowed" : clearly violates the policy, OR clearly outside the itinerary (wrong city, wrong dates, personal).
  - "Needs Review": ambiguous, borderline, missing info, or you are not sure. When in doubt pick this.

Return ONLY a JSON array (no markdown, no commentary). One object per invoice, in the SAME ORDER you received them:
[{"file_name":"<exact file_name>","classification":"Allowed|Not Allowed|Needs Review","reason":"one short sentence (<200 chars) citing the policy clause or itinerary fact that drove the decision"}]`;

/** Classify rows in the sheet using Policy + Itinerary. Does NOT move files. */
function classifyInvoices() {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const sheet = getOrCreateSheet(folder);
  const policy = loadOrInitPolicy(folder);
  const itinerary = loadOrInitItinerary(folder);

  if (!policy || !policy.trim()) {
    Logger.log('Policy is empty. Edit Policy.txt in the folder and re-run.');
    return;
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No invoice rows. Run extractInvoices first.'); return; }

  const data = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const cClass  = HEADERS.indexOf('Classification');
  const cReason = HEADERS.indexOf('Classification_Reason');

  const todo = [];
  data.forEach((row, i) => {
    if (!row[0]) return;
    if (!CONFIG.RECLASSIFY_ALL && row[cClass]) return;
    todo.push({ rowIndex: i + 2, fileName: row[0], row });
  });
  if (!todo.length) { Logger.log('Nothing to classify.'); return; }

  // Look up column indices by header name so adding/reordering columns
  // in Config.gs doesn't silently break this map.
  const col = (name) => HEADERS.indexOf(name);
  const invoices = todo.map(t => ({
    file_name:            t.row[col('File_Name')],
    date:                 t.row[col('Date')],
    country:              t.row[col('Country')],
    currency:             t.row[col('Currency')],
    amount:               t.row[col('Amount')],
    vendor_name:          t.row[col('Vendor Name')],
    city:                 t.row[col('City')],
    description:          t.row[col('Invoice Description')],
    detailed_description: t.row[col('Detailed_Description')],
  }));

  Logger.log(`Classifying ${invoices.length} invoice(s) via ${CONFIG.LLM_PROVIDER}...`);
  const results = CONFIG.LLM_PROVIDER === 'claude'
    ? classifyWithClaude(policy, itinerary, invoices)
    : classifyWithGemini(policy, itinerary, invoices);

  const byName = {};
  results.forEach(r => { if (r && r.file_name) byName[r.file_name] = r; });

  let written = 0, missing = 0;
  todo.forEach(t => {
    const r = byName[t.fileName];
    if (!r) { missing++; return; }
    const klass = normalizeClass(r.classification);
    sheet.getRange(t.rowIndex, cClass  + 1).setValue(klass);
    sheet.getRange(t.rowIndex, cReason + 1).setValue(r.reason || '');
    written++;
  });
  SpreadsheetApp.flush();
  Logger.log(`Classification done. written=${written}  missing_in_response=${missing}`);
}

function loadOrInitPolicy(folder) {
  const exts = [
    [CONFIG.POLICY_BASENAME + '.txt', 'text'],
    [CONFIG.POLICY_BASENAME + '.md',  'text'],
    [CONFIG.POLICY_BASENAME + '.pdf', 'pdf'],
    [CONFIG.POLICY_BASENAME, 'gdoc'] // Added: Google Docs usually don't have an extension in the name
  ];

  for (const [fname, kind] of exts) {
    const it = folder.getFilesByName(fname);
    if (it.hasNext()) {
      const f = it.next();

      // Handle Google Docs specifically to extract their text
      if (f.getMimeType() === MimeType.GOOGLE_DOCS || kind === 'gdoc') {
         return DocumentApp.openById(f.getId()).getBody().getText();
      }

      if (kind === 'text') return f.getBlob().getDataAsString();
      return { __pdf: true, file: f };
    }
  }

  const template = [
    '# Expense Policy',
    '',
    'Edit this file with your company\'s real rules. The model will read it as plain text.',
    '',
    '## Allowed',
    '- Meals up to USD 60 / day per person (non-alcoholic).',
    '- Ground transport (Uber/Lyft/taxi/train) between airport, hotel, and business sites.',
    '- Economy flights on dates inside the itinerary.',
    '- Hotel up to USD 250 / night for nights covered by the itinerary.',
    '- Wifi, baggage fees, business calls.',
    '',
    '## Not allowed',
    '- Alcoholic drinks (beer, wine, spirits, cocktails, mini-bar).',
    '- In-room movies, spa, gym add-ons, personal entertainment.',
    '- Expenses on dates outside the itinerary unless transit to/from airport.',
    '- Expenses in cities not on the itinerary.',
    '- Gifts, personal shopping.',
    '',
    '## Needs review (anything we cannot decide automatically)',
    '- Meals over the per-day cap.',
    '- Tips above 20%.',
    '- Receipts where city or date cannot be read.',
    '- Mixed personal + business charges.',
    '',
  ].join('\n');
  folder.createFile(CONFIG.POLICY_BASENAME + '.txt', template, MimeType.PLAIN_TEXT);
  Logger.log(`Created starter ${CONFIG.POLICY_BASENAME}.txt - edit it with your company rules and re-run.`);
  return template;
}

function loadOrInitItinerary(folder) {
  let sub;
  const it = folder.getFoldersByName(CONFIG.ITINERARY_SUBFOLDER);
  if (it.hasNext()) {
    sub = it.next();
  } else {
    sub = folder.createFolder(CONFIG.ITINERARY_SUBFOLDER);
    Logger.log(`Created '${CONFIG.ITINERARY_SUBFOLDER}/' - drop itinerary PDFs in there.`);
  }
  // Added MimeType.GOOGLE_DOCS to the allowed set
  const allowed = new Set([
    'application/pdf',
    'text/plain',
    'image/jpeg',
    'image/png',
    'image/webp',
    MimeType.GOOGLE_DOCS
  ]);
  const out = [];
  const fit = sub.getFiles();
  while (fit.hasNext()) {
    const f = fit.next();
    if (allowed.has(f.getMimeType())) out.push(f);
  }
  return out;
}

function classifyWithGemini(policy, itineraryFiles, invoices) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY missing in Script Properties');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;

  const parts = [{ text: CLASSIFICATION_PROMPT }];
  parts.push({ text: '\n\n=== EXPENSE POLICY ===\n' });
  if (policy && policy.__pdf) {
    parts.push({ inline_data: { mime_type: 'application/pdf', data: Utilities.base64Encode(policy.file.getBlob().getBytes()) } });
  } else {
    parts.push({ text: String(policy) });
  }
  parts.push({ text: '\n\n=== TRAVEL ITINERARY ===\n' });
  if (!itineraryFiles.length) parts.push({ text: '(no itinerary files provided)' });
  for (const f of itineraryFiles) {
    const mime = f.getMimeType();
    parts.push({ text: `\n--- ${f.getName()} ---\n` });

    // Check if it's a Google Doc and extract text
    if (mime === MimeType.GOOGLE_DOCS || mime === 'application/vnd.google-apps.document') {
      let docText = DocumentApp.openById(f.getId()).getBody().getText();
      parts.push({ text: extractLinksToMarkdown(docText) });
    } else if (mime === 'text/plain') {
      let plainText = f.getBlob().getDataAsString();
      parts.push({ text: extractLinksToMarkdown(plainText) });
    } else {
      parts.push({ inline_data: { mime_type: mime, data: Utilities.base64Encode(f.getBlob().getBytes()) } });
    }
  }
  parts.push({ text: `\n\n=== INVOICES TO CLASSIFY ===\n${JSON.stringify(invoices, null, 2)}\n\nReturn the JSON array now.` });
  const payload = {
    contents: [{ parts }],
    generationConfig: { response_mime_type: 'application/json', temperature: 0 },
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Gemini classify ${res.getResponseCode()}: ${res.getContentText().slice(0, 600)}`);
  }
  const text = JSON.parse(res.getContentText()).candidates[0].content.parts[0].text;
  return JSON.parse(stripFences(text));
}

function classifyWithClaude(policy, itineraryFiles, invoices) {
  const key = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!key) throw new Error('CLAUDE_API_KEY missing in Script Properties');

  const content = [];
  content.push({ type: 'text', text: CLASSIFICATION_PROMPT });
  content.push({ type: 'text', text: '\n\n=== EXPENSE POLICY ===\n' });
  if (policy && policy.__pdf) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(policy.file.getBlob().getBytes()) } });
  } else {
    content.push({ type: 'text', text: String(policy) });
  }
  content.push({ type: 'text', text: '\n\n=== TRAVEL ITINERARY ===\n' });
  if (!itineraryFiles.length) content.push({ type: 'text', text: '(no itinerary files provided)' });
  for (const f of itineraryFiles) {
    const mime = f.getMimeType();
    content.push({ type: 'text', text: `\n--- ${f.getName()} ---\n` });

    // Check if it's a Google Doc and extract text
    if (mime === MimeType.GOOGLE_DOCS || mime === 'application/vnd.google-apps.document') {
      content.push({ type: 'text', text: extractLinksToMarkdown(DocumentApp.openById(f.getId()).getBody().getText()) });
    } else if (mime === 'text/plain') {
      content.push({ type: 'text', text: extractLinksToMarkdown(f.getBlob().getDataAsString()) });
    } else if (mime === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(f.getBlob().getBytes()) } });
    } else if (mime.startsWith('image/') && mime !== 'image/heic' && mime !== 'image/heif') {
      content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: Utilities.base64Encode(f.getBlob().getBytes()) } });
    }
  }
  content.push({ type: 'text', text: `\n\n=== INVOICES TO CLASSIFY ===\n${JSON.stringify(invoices, null, 2)}\n\nReturn the JSON array now.` });
  const payload = {
    model: CONFIG.CLAUDE_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content }],
  };
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Claude classify ${res.getResponseCode()}: ${res.getContentText().slice(0, 600)}`);
  }
  const text = JSON.parse(res.getContentText()).content[0].text;
  return JSON.parse(stripFences(text));
}

/**
 * Diagnostic: dump the fully-resolved itinerary text (after Jina link scraping)
 * to a Google Doc named "Itinerary_Resolved" in the folder.
 * Run this any time you want to see exactly what reaches Claude/Gemini as
 * itinerary context — including which URLs were fetched, which failed, and
 * how big the payload is.
 */
function dumpResolvedItinerary() {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const itin = loadOrInitItinerary(folder);

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  let report = `Resolved at: ${new Date().toISOString()}\n`;
  report += `Itinerary files found: ${itin.length}\n`;

  let body = '';
  for (const f of itin) {
    const mime = f.getMimeType();
    body += `\n\n========== ${f.getName()} (${mime}) ==========\n\n`;
    let raw = '';
    if (mime === MimeType.GOOGLE_DOCS || mime === 'application/vnd.google-apps.document') {
      raw = DocumentApp.openById(f.getId()).getBody().getText();
    } else if (mime === 'text/plain') {
      raw = f.getBlob().getDataAsString();
    } else {
      body += `(binary file, ${f.getSize()} bytes, sent to model as-is — no link scraping applies)\n`;
      continue;
    }
    const urls = raw.match(urlRegex) || [];
    let ok = 0, failed = 0;
    const resolved = raw.replace(urlRegex, (url) => {
      try {
        const res = UrlFetchApp.fetch('https://r.jina.ai/' + url, { muteHttpExceptions: true });
        if (res.getResponseCode() === 200) {
          ok++;
          return `\n\n=== Content scraped from ${url} ===\n` + res.getContentText() + `\n=== End of ${url} ===\n`;
        }
        failed++;
        return `${url}  [JINA FAILED: HTTP ${res.getResponseCode()}]`;
      } catch (e) {
        failed++;
        return `${url}  [JINA FAILED: ${e.message}]`;
      }
    });
    report += `  - ${f.getName()}: ${urls.length} URL(s), ${ok} fetched OK, ${failed} failed\n`;
    body += resolved;
  }
  report += `\nTotal resolved payload size: ${body.length} chars (~${Math.round(body.length / 4)} tokens)\n`;

  const docName = 'Itinerary_Resolved';
  const it = folder.getFilesByName(docName);
  let doc;
  if (it.hasNext()) {
    doc = DocumentApp.openById(it.next().getId());
    doc.getBody().clear();
  } else {
    doc = DocumentApp.create(docName);
    const file = DriveApp.getFileById(doc.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }
  doc.getBody().setText(report + '\n\n--- PAYLOAD ---\n' + (body || '(empty)'));
  doc.saveAndClose();
  Logger.log(report);
  Logger.log(`Wrote ${body.length} chars of resolved itinerary to "${docName}" in folder "${folder.getName()}".`);
}

function extractLinksToMarkdown(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => {
    try {
      // Using Jina Reader to bypass JS-rendering issues and get clean text
      const res = UrlFetchApp.fetch('https://r.jina.ai/' + url, { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        return `\n\n=== Content scraped from ${url} ===\n` + res.getContentText() + `\n=== End of ${url} ===\n`;
      }
    } catch (e) {
      Logger.log("Failed to fetch link: " + url);
    }
    return url; // fallback to just returning the URL if scraping fails
  });
}
