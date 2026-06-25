import { createServer } from "node:http";
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = loadPlaywright();
const DATA_DIR = path.join(__dirname, "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const RECORDS_FILE = path.join(DATA_DIR, "records.ndjson");
const CONFIG_FILE = path.join(__dirname, "config.json");
const PORT = Number(process.env.PORT || 8787);

const state = {
  pendingSelection: null,
  selectionStatus: "idle",
  selectionError: "",
  jobs: [],
  runningJobs: new Set(),
};

function loadPlaywright() {
  const candidates = [
    path.join(__dirname, "node_modules", "playwright"),
    path.join(__dirname, "..", "node_modules", ".pnpm", "playwright@1.60.0", "node_modules", "playwright"),
  ];

  for (const candidate of candidates) {
    const packageRoot = path.resolve(candidate, "..");
    const hasPlaywrightCore =
      existsSync(path.join(packageRoot, "playwright-core")) ||
      existsSync(path.join(packageRoot, ".pnpm", "playwright-core@1.60.0", "node_modules", "playwright-core"));
    if (existsSync(candidate) && hasPlaywrightCore) {
      return require(candidate);
    }
  }

  return require("playwright");
}

await mkdir(DATA_DIR, { recursive: true });
state.jobs = await loadJobs();
scheduleLoop();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return sendFile(res, path.join(__dirname, "public", "index.html"), "text/html");
    if (req.method === "GET" && url.pathname === "/app.js") return sendFile(res, path.join(__dirname, "public", "app.js"), "text/javascript");
    if (req.method === "GET" && url.pathname === "/api/status") return sendJson(res, publicState());
    if (req.method === "POST" && url.pathname === "/api/select") return startSelection(req, res);
    if (req.method === "POST" && url.pathname === "/api/jobs") return createJob(req, res);
    if (req.method === "POST" && /^\/api\/jobs\/[^/]+\/run$/.test(url.pathname)) return runJobNow(url.pathname.split("/")[3], res);
    if (req.method === "DELETE" && /^\/api\/jobs\/[^/]+$/.test(url.pathname)) return deleteJob(url.pathname.split("/")[3], res);
    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    sendJson(res, { error: error.message || String(error) }, 500);
  }
}).listen(PORT, () => {
  console.log(`Visual Data Collector running at http://localhost:${PORT}`);
});

async function startSelection(req, res) {
  const body = await readJson(req);
  const targetUrl = String(body.url || "").trim();
  if (!/^https?:\/\//i.test(targetUrl)) return sendJson(res, { error: "Please enter a full http:// or https:// URL." }, 400);

  state.pendingSelection = null;
  state.selectionStatus = "opening";
  state.selectionError = "";
  sendJson(res, { ok: true });

  selectValuesInBrowser(targetUrl).catch((error) => {
    state.selectionStatus = "error";
    state.selectionError = error.message || String(error);
  });
}

async function createJob(req, res) {
  const body = await readJson(req);
  const selected = state.pendingSelection;
  if (!selected || selected.url !== body.url) return sendJson(res, { error: "No confirmed selection found for this URL." }, 400);

  const frequency = String(body.frequency || "").toLowerCase();
  if (!["daily", "weekly", "monthly"].includes(frequency)) return sendJson(res, { error: "Frequency must be daily, weekly, or monthly." }, 400);
  const submittedFields = Array.isArray(body.fields) ? body.fields : [];

  const job = {
    id: `job_${Date.now()}`,
    name: body.name || new URL(selected.url).hostname,
    url: selected.url,
    frequency,
    storageState: selected.storageState || null,
    fields: selected.fields.map((field, index) => {
      const submitted = submittedFields[index] || {};
      return {
        name: cleanFieldName(submitted.name || field.name || `Value ${index + 1}`, index),
        selector: field.selector,
        sample: field.text,
      };
    }),
    createdAt: new Date().toISOString(),
    lastRunAt: "",
    nextRunAt: new Date().toISOString(),
    status: "created",
    lastError: "",
  };

  state.jobs.push(job);
  await saveJobs();
  state.pendingSelection = null;
  runJob(job.id).catch(console.error);
  sendJson(res, { ok: true, job });
}

function cleanFieldName(value, index) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  return name || `Value ${index + 1}`;
}

async function runJobNow(jobId, res) {
  const record = await runJob(jobId);
  sendJson(res, { ok: true, record });
}

async function deleteJob(jobId, res) {
  state.jobs = state.jobs.filter((job) => job.id !== jobId);
  await saveJobs();
  sendJson(res, { ok: true });
}

async function selectValuesInBrowser(targetUrl) {
  const browser = await launchBrowser(false);
  const context = await browser.newContext();
  const page = await context.newPage();
  state.selectionStatus = "waiting";

  await page.exposeBinding("__collectorConfirm", async (_source, payload) => {
    const storageState = await context.storageState();
    state.pendingSelection = {
      url: targetUrl,
      fields: payload.fields || [],
      storageState,
      confirmedAt: new Date().toISOString(),
    };
    state.selectionStatus = "confirmed";
    await browser.close();
  });

  await page.addInitScript(selectionOverlayScript());
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.evaluate(selectionOverlayScript());
}

async function runJob(jobId) {
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (state.runningJobs.has(jobId)) return null;

  state.runningJobs.add(jobId);
  job.status = "running";
  job.lastError = "";
  await saveJobs();

  let browser;
  try {
    browser = await launchBrowser(true);
    const context = await browser.newContext(job.storageState ? { storageState: job.storageState } : {});
    const page = await context.newPage();
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);

    const values = [];
    for (const field of job.fields) {
      const value = await readSelectorValue(page, field);
      values.push({ name: field.name, selector: field.selector, value });
    }

    const record = {
      capturedAt: new Date().toISOString(),
      jobId: job.id,
      jobName: job.name,
      url: job.url,
      frequency: job.frequency,
      values,
    };

    await appendFile(RECORDS_FILE, `${JSON.stringify(record)}\n`, "utf8");
    await uploadToGoogleSheet(record);

    job.lastRunAt = record.capturedAt;
    job.nextRunAt = nextRunAt(job.frequency, new Date()).toISOString();
    job.status = "ok";
    await saveJobs();
    return record;
  } catch (error) {
    job.status = "error";
    job.lastError = error.message || String(error);
    job.nextRunAt = nextRunAt(job.frequency, new Date()).toISOString();
    await saveJobs();
    throw error;
  } finally {
    if (browser) await browser.close();
    state.runningJobs.delete(jobId);
  }
}

async function readSelectorValue(page, field) {
  const selector = field.selector;
  const locator = page.locator(selector).first();

  try {
    await locator.waitFor({ state: "attached", timeout: 15000 });
    const value = await waitForLocatorText(page, locator, 12000);
    if (value) return normalizeCapturedText(value);
  } catch {
    // Fall through to text-based recovery below.
  }

  const sample = normalizeCapturedText(field.sample || "");
  if (sample) {
    const bySample = await readByExactText(page, sample);
    if (bySample) return bySample;
  }

  const name = normalizeCapturedText(field.name || "");
  if (name && !/^value\s+\d+$/i.test(name) && !/^prodpricediv/i.test(name)) {
    const byName = await readByExactText(page, name);
    if (byName) return byName;
  }

  return sample || "";
}

async function waitForLocatorText(page, locator, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await locator.evaluate((element) => {
      if ("value" in element && element.value) return element.value;
      return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    }).catch(() => "");
    if (normalizeCapturedText(value)) return value;
    await page.waitForTimeout(500);
  }
  return "";
}

async function readByExactText(page, text) {
  try {
    const locator = page.getByText(text, { exact: true }).first();
    await locator.waitFor({ state: "attached", timeout: 3000 });
    const value = await waitForLocatorText(page, locator, 2000);
    return normalizeCapturedText(value);
  } catch {
    return "";
  }
}

function normalizeCapturedText(value) {
  return String(value || "")
    .replace(/Ã‚Â£|Ãƒâ€šÃ‚Â£/g, "Â£")
    .replace(/\s+/g, " ")
    .trim();
}

async function launchBrowser(headless) {
  const attempts = [
    { channel: "msedge", headless },
    { channel: "chrome", headless },
    { headless },
  ];
  const errors = [];

  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  throw new Error(
    "Could not open a browser. Install Microsoft Edge/Google Chrome, or run: npx playwright install chromium\n\n" +
    errors.join("\n\n")
  );
}

async function uploadToGoogleSheet(record) {
  const config = await loadConfig();
  if (!config.googleSheetWebAppUrl) return;

  const response = await fetch(config.googleSheetWebAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: config.sharedSecret || "",
      record,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google Sheet upload failed: HTTP ${response.status} ${await response.text()}`);
  }

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch (error) {
    throw new Error(`Google Sheet upload did not return JSON. Check Web App deployment/access. Response: ${text.slice(0, 200)}`);
  }

  if (!result.ok) {
    throw new Error(`Google Sheet upload failed: ${result.error || text}`);
  }
}

function scheduleLoop() {
  setInterval(() => {
    const now = Date.now();
    state.jobs
      .filter((job) => job.nextRunAt && new Date(job.nextRunAt).getTime() <= now)
      .forEach((job) => runJob(job.id).catch(console.error));
  }, 60000);
}

function nextRunAt(frequency, fromDate) {
  const next = new Date(fromDate);
  if (frequency === "daily") next.setDate(next.getDate() + 1);
  if (frequency === "weekly") next.setDate(next.getDate() + 7);
  if (frequency === "monthly") next.setMonth(next.getMonth() + 1);
  return next;
}

async function loadJobs() {
  if (!existsSync(JOBS_FILE)) return [];
  return JSON.parse(await readFile(JOBS_FILE, "utf8"));
}

async function saveJobs() {
  await writeFile(JOBS_FILE, JSON.stringify(state.jobs, null, 2), "utf8");
}

async function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
}

function publicState() {
  const pendingSelection = state.pendingSelection ? {
    url: state.pendingSelection.url,
    fields: state.pendingSelection.fields,
    confirmedAt: state.pendingSelection.confirmedAt,
  } : null;
  const jobs = state.jobs.map((job) => {
    const copy = { ...job };
    delete copy.storageState;
    return copy;
  });
  return {
    selectionStatus: state.selectionStatus,
    selectionError: state.selectionError,
    pendingSelection,
    jobs,
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function sendFile(res, filePath, contentType) {
  res.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8` });
  res.end(await readFile(filePath));
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function selectionOverlayScript() {
  return String.raw`
    (() => {
      if (document.getElementById("vdc-panel")) return;
      const selected = new Map();
      const style = document.createElement("style");
      style.textContent = [
        ".vdc-selected { outline: 3px solid #19a974 !important; outline-offset: 2px !important; }",
        "#vdc-panel { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; width: 280px; background: #111827; color: white; font: 13px Arial, sans-serif; padding: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.3); border-radius: 8px; }",
        "#vdc-panel button { border: 0; border-radius: 6px; padding: 8px 10px; cursor: pointer; }",
        "#vdc-confirm { background: #19a974; color: #fff; }",
        "#vdc-clear { background: #374151; color: #fff; margin-left: 8px; }",
        "#vdc-count { font-weight: 700; }",
        "#vdc-list { margin: 8px 0; max-height: 160px; overflow: auto; }",
        ".vdc-item { border-top: 1px solid rgba(255,255,255,.18); padding: 6px 0; }",
        ".vdc-item strong { display: block; font-size: 12px; }",
        ".vdc-item span { color: #d1d5db; font-size: 12px; }"
      ].join("\n");
      document.documentElement.appendChild(style);

      const panel = document.createElement("div");
      panel.id = "vdc-panel";
      panel.innerHTML = '<div><strong>Select values to trace</strong></div><div style="margin:8px 0">Selected: <span id="vdc-count">0</span></div><div id="vdc-list"></div><button id="vdc-confirm">Confirm</button><button id="vdc-clear">Clear</button>';
      document.documentElement.appendChild(panel);

      document.addEventListener("click", (event) => {
        if (event.target.closest("#vdc-panel")) return;
        event.preventDefault();
        event.stopPropagation();
        const element = event.target;
        const selector = cssPath(element);
        if (selected.has(selector)) {
          selected.delete(selector);
          element.classList.remove("vdc-selected");
        } else {
          const text = elementText(element);
          selected.set(selector, {
            selector,
            name: inferFieldName(element, text, selected.size + 1),
            text,
          });
          element.classList.add("vdc-selected");
        }
        renderSelectionList();
      }, true);

      document.getElementById("vdc-clear").addEventListener("click", () => {
        document.querySelectorAll(".vdc-selected").forEach((element) => element.classList.remove("vdc-selected"));
        selected.clear();
        renderSelectionList();
      });

      document.getElementById("vdc-confirm").addEventListener("click", () => {
        window.__collectorConfirm({ fields: Array.from(selected.values()) });
      });

      function renderSelectionList() {
        document.getElementById("vdc-count").textContent = String(selected.size);
        const list = document.getElementById("vdc-list");
        list.innerHTML = "";
        Array.from(selected.values()).forEach((field) => {
          const item = document.createElement("div");
          item.className = "vdc-item";
          item.innerHTML = "<strong></strong><span></span>";
          item.querySelector("strong").textContent = field.name;
          item.querySelector("span").textContent = field.text || "(blank)";
          list.appendChild(item);
        });
      }

      function elementText(element) {
        return (element.innerText || element.textContent || element.value || "").replace(/\s+/g, " ").trim().slice(0, 300);
      }

      function inferFieldName(element, text, fallbackNumber) {
        const direct = element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("name") || element.id || "";
        if (direct) return cleanName(direct);

        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
          const label = document.getElementById(labelledBy);
          if (label && elementText(label)) return cleanName(elementText(label));
        }

        if (element.labels && element.labels.length > 0 && elementText(element.labels[0])) {
          return cleanName(elementText(element.labels[0]));
        }

        const row = element.closest("tr");
        if (row) {
          const header = row.querySelector("th, td");
          if (header && header !== element && elementText(header)) return cleanName(elementText(header));
        }

        const previous = element.previousElementSibling;
        if (previous && elementText(previous) && elementText(previous).length <= 80) return cleanName(elementText(previous));

        const parent = element.parentElement;
        if (parent) {
          const parentText = elementText(parent);
          if (parentText && parentText !== text && parentText.length <= 100) return cleanName(parentText.replace(text, ""));
        }

        if (text && text.length <= 40) return cleanName(text);
        return "Value " + fallbackNumber;
      }

      function cleanName(value) {
        return String(value || "").replace(/\s+/g, " ").replace(/[:|]+$/g, "").trim().slice(0, 80) || "Value";
      }

      function cssPath(element) {
        if (element.id && /^[A-Za-z][\w-]*$/.test(element.id)) return "#" + CSS.escape(element.id);
        const parts = [];
        let current = element;
        while (current && current.nodeType === 1 && current !== document.body) {
          let part = current.localName.toLowerCase();
          for (const attr of ["data-testid", "data-test", "data-id", "name", "aria-label"]) {
            const value = current.getAttribute(attr);
            if (value) {
              part += "[" + attr + "=" + JSON.stringify(value) + "]";
              break;
            }
          }
          if (!part.includes("[")) {
            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((child) => child.localName === current.localName);
              if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
            }
          }
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(" > ");
      }
    })();
  `;
}
