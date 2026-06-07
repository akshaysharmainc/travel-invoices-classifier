/**
 * File 4: MoveFiles.gs
 * Dedicated module to handle organizing and moving the actual Drive
 * files based on the classifications logged in the Google Sheet.
 *
 * On move, each file is also renamed to:
 *     <YYYYMMDD>_<CCY>_<Amount>_<Vendor>.<ext>
 * e.g. 20260423_GBP_18_Giraffe Heathrow T3.jpg
 *
 * If any of Date / Currency / Amount / Vendor Name is missing or invalid,
 * the rename is skipped for that row but the file still gets moved.
 *
 * After a successful rename, the sheet's File_Name cell is updated so the
 * next run can still locate the file.
 */

/** Move each invoice into Allowed/Not_Allowed/Needs_Review based on the sheet's Classification column. */
function moveClassifiedFiles() {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const sheet = getOrCreateSheet(folder);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No rows.'); return; }

  const data = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const col = (n) => HEADERS.indexOf(n);
  const cName  = col('File_Name');
  const cClass = col('Classification');
  const cDate  = col('Date');
  const cCur   = col('Currency');
  const cAmt   = col('Amount');
  const cVend  = col('Vendor Name');

  let moved = 0, renamed = 0, skipped = 0, notFound = 0;
  data.forEach((row, i) => {
    const rowIndex = i + 2; // 1-based sheet row
    const name = row[cName];
    const klass = normalizeClass(row[cClass]);
    if (!name || !klass) { skipped++; return; }

    const subName =
      klass === 'Allowed'     ? CONFIG.ALLOWED_SUBFOLDER     :
      klass === 'Not Allowed' ? CONFIG.NOT_ALLOWED_SUBFOLDER :
      klass === 'Needs Review'? CONFIG.REVIEW_SUBFOLDER      : null;
    if (!subName) { skipped++; return; }

    const file = findInvoiceFile(folder, name);
    if (!file) { notFound++; return; }

    // 1) Rename in place (if we have enough data and the name is different)
    const desired = buildRenamedFileName(name, row[cDate], row[cCur], row[cAmt], row[cVend]);
    if (desired && desired !== file.getName()) {
      const unique = makeUniqueName(folder, desired, file.getId());
      file.setName(unique);
      sheet.getRange(rowIndex, cName + 1).setValue(unique);
      renamed++;
    }

    // 2) Move into the classification subfolder (if not already there)
    const target = getOrCreateSubfolder(folder, subName);
    const parents = file.getParents();
    const alreadyThere = parents.hasNext() && parents.next().getId() === target.getId();
    if (!alreadyThere) {
      file.moveTo(target);
      moved++;
    }
  });
  SpreadsheetApp.flush();
  Logger.log(`Move done. moved=${moved}  renamed=${renamed}  skipped=${skipped}  not_found=${notFound}`);
}

/**
 * Build "YYYYMMDD_CCY_Amount_Vendor.ext".
 * Returns null if any required field is missing or invalid so the caller
 * can fall back to leaving the original name in place.
 */
function buildRenamedFileName(originalName, date, currency, amount, vendor) {
  if (!date || !currency || !vendor) return null;
  if (amount === '' || amount === null || amount === undefined) return null;

  // Date: handle Date objects (Sheets auto-converts YYYY-MM-DD strings to dates),
  // YYYY-MM-DD strings, and bare YYYYMMDD strings. Output YYYYMMDD.
  let dateStr;
  if (Object.prototype.toString.call(date) === '[object Date]' && !isNaN(date)) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    dateStr = `${y}${m}${d}`;
  } else {
    dateStr = String(date).replace(/-/g, '').trim();
  }
  if (!/^\d{8}$/.test(dateStr)) return null;

  const cur  = String(currency).trim().toUpperCase();
  const amt  = String(amount).trim();
  const vend = sanitizeForFilename(String(vendor).trim());
  if (!cur || !amt || !vend) return null;

  const ext = getExtension(originalName);
  return `${dateStr}_${cur}_${amt}_${vend}${ext}`;
}

/** Strip filesystem-unfriendly characters, collapse whitespace, cap length. */
function sanitizeForFilename(s) {
  return s
    .replace(/[\/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Return the extension including the dot, lower-cased; '' if none. */
function getExtension(name) {
  const m = String(name).match(/(\.[A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Avoid name collisions inside the folder tree (root + classification subfolders).
 * If "desired" already exists on a different file, returns "<base>_2.<ext>", then _3, etc.
 */
function makeUniqueName(folder, desired, ignoreFileId) {
  const places = [folder];
  for (const sub of [CONFIG.ALLOWED_SUBFOLDER, CONFIG.NOT_ALLOWED_SUBFOLDER, CONFIG.REVIEW_SUBFOLDER]) {
    const it = folder.getFoldersByName(sub);
    if (it.hasNext()) places.push(it.next());
  }
  const extMatch = desired.match(/(\.[A-Za-z0-9]{1,8})$/);
  const ext  = extMatch ? extMatch[0] : '';
  const base = extMatch ? desired.slice(0, -ext.length) : desired;

  let candidate = desired;
  let n = 2;
  while (collidesWithOther(places, candidate, ignoreFileId)) {
    candidate = `${base}_${n}${ext}`;
    n++;
    if (n > 50) break; // safety
  }
  return candidate;
}

function collidesWithOther(places, name, ignoreFileId) {
  for (const p of places) {
    const it = p.getFilesByName(name);
    while (it.hasNext()) {
      if (it.next().getId() !== ignoreFileId) return true;
    }
  }
  return false;
}

/** Helper: Searches the main folder and subfolders for a specific file name */
function findInvoiceFile(folder, fileName) {
  const places = [folder];
  for (const sub of [CONFIG.ALLOWED_SUBFOLDER, CONFIG.NOT_ALLOWED_SUBFOLDER, CONFIG.REVIEW_SUBFOLDER]) {
    const it = folder.getFoldersByName(sub);
    if (it.hasNext()) places.push(it.next());
  }
  for (const p of places) {
    const fit = p.getFilesByName(fileName);
    if (fit.hasNext()) return fit.next();
  }
  return null;
}

/** Helper: Safely gets or creates a folder by name inside a parent folder */
function getOrCreateSubfolder(folder, name) {
  const it = folder.getFoldersByName(name);
  return it.hasNext() ? it.next() : folder.createFolder(name);
}
