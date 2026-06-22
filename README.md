# Visual Data Collector

This is a local browser-assisted data collector.

Workflow:

1. Start the local app.
2. Enter a URL.
3. A Chromium browser opens.
4. Click one or more values on the page.
5. Click the floating `Confirm` button.
6. Choose `daily`, `weekly`, or `monthly`.
7. The app grabs the data once immediately, then repeats while the app is running.
8. Results are saved locally and can also be posted into a Google Sheet.

## Start The App

On Windows, run:

```powershell
.\Start-VisualCollector.ps1
```

Or with Node.js:

```powershell
npm install
npm start
```

Then open:

```text
http://localhost:8787
```

## Google Sheet Upload

Create or open the Google Sheet where the collected rows should go.

In the Sheet:

1. Go to `Extensions` > `Apps Script`.
2. Paste the code from `google-apps-script/SheetReceiver.gs`.
3. Change `SHARED_SECRET` to a private value.
4. Click `Deploy` > `New deployment`.
5. Choose `Web app`.
6. Execute as: `Me`.
7. Who has access: `Anyone`.
8. Deploy and copy the Web app URL.

Then copy `config.example.json` to `config.json` beside `server.mjs`:

```json
{
  "googleSheetWebAppUrl": "PASTE_WEB_APP_URL_HERE",
  "sharedSecret": "PASTE_THE_SAME_SECRET_HERE"
}
```

Restart the local app after changing `config.json`.

## Local Data

Jobs are stored in:

```text
data/jobs.json
```

Captured records are also saved locally in:

```text
data/records.ndjson
```

## Important Notes

- `config.json` is private and is ignored by Git. Do not commit your Web App URL or shared secret.
- `data/` is private and is ignored by Git. It can contain selected jobs, captured records, cookies, and browser storage.
- The scheduled grabs run only while this local app is running.
- If a website changes its layout, a saved selector may stop matching and the value will be blank.
- Some websites block automated browsers or require login/cookies. Those may need site-specific handling.
- For JavaScript-heavy pages, the first version waits for `domcontentloaded`; if a value loads later, use `Run now` after the page has settled or add a custom wait in the job code.
