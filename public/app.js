const form = document.getElementById("decision-form");
const resultBox = document.getElementById("decision-result");
const ledgerList = document.getElementById("ledger-list");
const modal = document.getElementById("verify-modal");
const modalBody = document.getElementById("modal-body");

const presets = {
  approve: {
    applicantName: "Rohan Deshmukh",
    income: 85000,
    creditScore: 762,
    requestedAmount: 300000,
  },
  review: {
    applicantName: "Sneha Kulkarni",
    income: 40000,
    creditScore: 671,
    requestedAmount: 180000,
  },
  reject: {
    applicantName: "Vikram Salunkhe",
    income: 22000,
    creditScore: 590,
    requestedAmount: 400000,
  },
};

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const p = presets[btn.dataset.preset];
    document.getElementById("applicantName").value = p.applicantName;
    document.getElementById("income").value = p.income;
    document.getElementById("creditScore").value = p.creditScore;
    document.getElementById("requestedAmount").value = p.requestedAmount;
  });
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    applicantName: document.getElementById("applicantName").value,
    income: Number(document.getElementById("income").value),
    creditScore: Number(document.getElementById("creditScore").value),
    requestedAmount: Number(document.getElementById("requestedAmount").value),
  };
  const res = await fetch("/api/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Something went wrong");
    return;
  }
  resultBox.className = `decision-result ${data.decision}`;
  resultBox.innerHTML = `
    <span class="badge">${data.decision.replace(/_/g, " ")}</span>
    ${data.reason}<br/><br/>
    Evidence sealed \u2014 record ID:<br/>
    <span class="record-id">${data.id}</span>
  `;
  loadLedger();
});

function statusChip(d) {
  if (d.tampered) return `<span class="status-chip tampered">Tampered</span>`;
  return `<span class="status-chip ${d.decision}">${d.decision.replace(/_/g, " ")}</span>`;
}

async function loadLedger() {
  const res = await fetch("/api/decisions");
  const data = await res.json();
  if (!data.length) {
    ledgerList.innerHTML = `<div class="empty-state">No decisions yet. Run one from the left panel.</div>`;
    return;
  }
  ledgerList.innerHTML = data
    .map(
      (d) => `
    <div class="ledger-row ${d.tampered ? "is-tampered" : ""}" data-id="${d.id}">
      <div class="row-main">
        <div class="row-top">
          <span class="row-applicant">${d.applicant}</span>
          ${statusChip(d)}
        </div>
        <div class="row-meta">₹${d.requestedAmount.toLocaleString("en-IN")} requested &middot; ${d.model} &middot; ${new Date(d.timestamp).toLocaleString()}</div>
        <div class="row-id">${d.id}</div>
      </div>
      <div class="row-actions">
        <button class="primary" data-action="verify" data-id="${d.id}">Verify</button>
        <button data-action="view" data-id="${d.id}">View receipt</button>
        <a href="/api/receipt/${d.id}" download><button data-action="download">Download</button></a>
        <button class="danger" data-action="tamper" data-id="${d.id}" ${d.tampered ? "disabled" : ""}>Simulate tamper</button>
      </div>
    </div>
  `,
    )
    .join("");
}

ledgerList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;

  if (btn.dataset.action === "verify") {
    const res = await fetch(`/api/verify/${id}`, { method: "POST" });
    const verdict = await res.json();
    showVerdict(verdict);
  }

  if (btn.dataset.action === "view") {
    const res = await fetch(`/api/receipt/${id}/view`);
    const receipt = await res.json();
    showReceipt(receipt);
  }

  if (btn.dataset.action === "tamper") {
    await fetch(`/api/tamper/${id}`, { method: "POST" });
    loadLedger();
  }
});

document.getElementById("seed-btn").addEventListener("click", async () => {
  await fetch("/api/seed-demo", { method: "POST" });
  loadLedger();
});

const PII_FIELDS = new Set([
  "applicantName",
  "applicant_name",
  "name",
  "fullName",
  "firstName",
  "lastName",
  "income",
  "annualIncome",
  "monthlyIncome",
  "creditScore",
  "credit_score",
  "email",
  "phone",
  "phoneNumber",
  "address",
  "streetAddress",
  "pan",
  "panNumber",
  "aadhaar",
  "aadhaarNumber",
  "dateOfBirth",
  "dob",
]);

function containsPII(value) {
  if (!value || typeof value !== "object") return false;

  if (Array.isArray(value)) {
    return value.some(containsPII);
  }

  return Object.entries(value).some(([key, val]) => {
    if (PII_FIELDS.has(key)) return true;
    return containsPII(val);
  });
}

function showReceipt(receipt) {
  document.getElementById("modal-title").textContent = "Raw Evidence Receipt";

  const hasPII = containsPII(receipt);

  const piiCheck = !hasPII
    ? `
      <div class="verdict-banner pass">
        No applicant name, income, or credit score anywhere in this file — only salted hashes.
      </div>
    `
    : `
      <div class="verdict-banner fail">
        Privacy check failed — applicant information was detected in this receipt.
      </div>
    `;

  modalBody.innerHTML = `
    ${piiCheck}
    <pre class="receipt-json">${JSON.stringify(receipt, null, 2)}</pre>
  `;

  modal.classList.remove("hidden");
}

function checkRow(name, check) {
  return `
    <div class="check-row">
      <div>
        <div class="check-name">${name}</div>
        <div class="check-detail">${check.detail}</div>
      </div>
      <span class="check-status ${check.status}">${check.status}</span>
    </div>
  `;
}

function showVerdict(verdict) {
  document.getElementById("modal-title").textContent = "Verification Result";
  const banner = verdict.ok
    ? `<div class="verdict-banner pass">\u2713 VERIFIED \u2014 this receipt is authentic and unaltered</div>`
    : `<div class="verdict-banner fail">\u2717 FAILED \u2014 this receipt does not check out</div>`;

  const checks = Object.entries(verdict.checks)
    .map(([name, check]) => checkRow(name, check))
    .join("");

  const reasons =
    verdict.reasons && verdict.reasons.length
      ? `<div class="reasons"><strong>Why it failed:</strong><ul>${verdict.reasons.map((r) => `<li>${r}</li>`).join("")}</ul></div>`
      : "";

  modalBody.innerHTML = banner + checks + reasons;
  modal.classList.remove("hidden");
}

document
  .getElementById("modal-close")
  .addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
});
document.getElementById("refresh-btn").addEventListener("click", loadLedger);
document.getElementById("reset-btn").addEventListener("click", async () => {
  const confirmed = confirm("Reset all decisions?");
  if (!confirmed) return;

  const res = await fetch("/api/reset", { method: "POST" });

  if (!res.ok) {
    alert("Reset failed");
    return;
  }

  resultBox.innerHTML = "";
  resultBox.className = "decision-result";
  await loadLedger();
});

loadLedger();
