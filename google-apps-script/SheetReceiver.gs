const SHARED_SECRET = 'change-this-secret';
const SHEET_NAME = 'Collected Data';
const HEADERS = [
  'Captured At',
  'Job Name',
  'Source URL',
  'Frequency',
  'Field Name',
  'Value',
  'Selector',
  'Job ID',
];

function doPost(e) {
  const payload = JSON.parse(e.postData.contents || '{}');
  if (SHARED_SECRET && payload.token !== SHARED_SECRET) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Invalid token' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(spreadsheet);
  const record = payload.record || {};
  const values = record.values || [];
  const rows = values.map((field) => [
    record.capturedAt || new Date(),
    record.jobName || '',
    record.url || '',
    record.frequency || '',
    field.name || '',
    field.value || '',
    field.selector || '',
    record.jobId || '',
  ]);

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, rows: rows.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SHEET_NAME) || spreadsheet.insertSheet(SHEET_NAME);
  const existing = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const matches = HEADERS.every((header, index) => existing[index] === header);
  if (!matches) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
