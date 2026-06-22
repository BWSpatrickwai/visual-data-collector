const selectForm = document.getElementById("select-form");
const jobForm = document.getElementById("job-form");
const statusEl = document.getElementById("select-status");
const confirmSection = document.getElementById("confirm-section");
const fieldsEl = document.getElementById("selected-fields");
const jobsEl = document.getElementById("jobs");
let currentState = null;

selectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = document.getElementById("url").value.trim();
  statusEl.textContent = "Opening browser. Click values on the page, then click Confirm in the floating panel.";
  statusEl.className = "status";
  confirmSection.hidden = true;
  await postJson("/api/select", { url });
  refresh();
});

jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentState?.pendingSelection) return;
  const body = {
    url: currentState.pendingSelection.url,
    name: document.getElementById("name").value.trim(),
    frequency: document.getElementById("frequency").value,
  };
  await postJson("/api/jobs", body);
  confirmSection.hidden = true;
  statusEl.textContent = "Job saved. The first grab is running now.";
  refresh();
});

async function refresh() {
  currentState = await getJson("/api/status");
  renderStatus(currentState);
  renderPending(currentState.pendingSelection);
  renderJobs(currentState.jobs || []);
}

function renderStatus(state) {
  if (state.selectionError) {
    statusEl.textContent = state.selectionError;
    statusEl.className = "status error";
    return;
  }
  if (state.selectionStatus === "opening") statusEl.textContent = "Opening browser...";
  if (state.selectionStatus === "waiting") statusEl.textContent = "Browser is open. Select one or more values, then click Confirm in the floating panel.";
  if (state.selectionStatus === "confirmed") statusEl.textContent = "Selection confirmed. Choose the schedule below.";
}

function renderPending(selection) {
  if (!selection) {
    confirmSection.hidden = true;
    return;
  }

  confirmSection.hidden = false;
  document.getElementById("url").value = selection.url;
  fieldsEl.innerHTML = "";
  selection.fields.forEach((field, index) => {
    const row = document.createElement("div");
    row.className = "field";
    row.innerHTML = `
      <label>Field ${index + 1} name</label>
      <input value="${escapeHtml(field.name || `Value ${index + 1}`)}" data-field-name="${index}">
      <div class="muted">${escapeHtml(field.text || "")}</div>
      <div class="muted"><code>${escapeHtml(field.selector)}</code></div>
    `;
    row.querySelector("input").addEventListener("input", (event) => {
      selection.fields[index].name = event.target.value;
    });
    fieldsEl.appendChild(row);
  });
}

function renderJobs(jobs) {
  jobsEl.innerHTML = "";
  if (jobs.length === 0) {
    jobsEl.innerHTML = `<div class="muted">No jobs yet.</div>`;
    return;
  }

  jobs.forEach((job) => {
    const row = document.createElement("div");
    row.className = "job";
    row.innerHTML = `
      <div class="job-header">
        <strong>${escapeHtml(job.name)}</strong>
        <span class="muted">${escapeHtml(job.status || "")}</span>
      </div>
      <div class="muted">${escapeHtml(job.url)}</div>
      <div class="muted">Frequency: ${escapeHtml(job.frequency)} | Last run: ${escapeHtml(job.lastRunAt || "never")} | Next run: ${escapeHtml(job.nextRunAt || "")}</div>
      ${job.lastError ? `<div class="error">${escapeHtml(job.lastError)}</div>` : ""}
      <div>
        <button class="secondary" data-run="${job.id}">Run now</button>
        <button class="secondary" data-delete="${job.id}">Delete</button>
      </div>
    `;
    row.querySelector("[data-run]").addEventListener("click", async () => {
      await postJson(`/api/jobs/${job.id}/run`, {});
      refresh();
    });
    row.querySelector("[data-delete]").addEventListener("click", async () => {
      await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      refresh();
    });
    jobsEl.appendChild(row);
  });
}

async function getJson(url) {
  const response = await fetch(url);
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed");
  return json;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

refresh();
setInterval(refresh, 2000);
