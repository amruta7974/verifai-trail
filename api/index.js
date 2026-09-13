import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { CooL, verifyEvidence } from "cool-nwc";
import { getDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Vercel serves /public as static assets automatically and only routes
// /api/* into this function (see vercel.json). This line is what makes
// `node api/index.js` also work as a plain local dev server.
app.use(express.static(path.join(__dirname, "..", "public")));

const cool = new CooL({ applicationId: "verifai-trail-demo" });

function maskApplicant(name) {
  if (!name || name.length < 3) return "APP-***";
  return name[0] + "*".repeat(name.length - 2) + name[name.length - 1];
}

function decide({ income, creditScore, requestedAmount }) {
  const maxAutoApprovalAmount = income * 5;

  const creditPass = creditScore >= 720;
  const amountPass = requestedAmount <= maxAutoApprovalAmount;

  if (creditPass && amountPass) {
    return {
      decision: "APPROVED",
      reason:
        "Strong credit score and requested amount within income multiple.",
      explanation: {
        creditScore,
        creditThreshold: 720,
        creditPass,
        monthlyIncome: income,
        requestedAmount,
        maxAutoApprovalAmount,
        amountPass,
      },
    };
  }

  if (creditScore >= 650) {
    return {
      decision: "FLAGGED_FOR_REVIEW",
      reason: "Borderline credit score — routed to a human underwriter.",
      explanation: {
        creditScore,
        creditThreshold: 720,
        creditPass,
        monthlyIncome: income,
        requestedAmount,
        maxAutoApprovalAmount,
        amountPass,
      },
    };
  }

  return {
    decision: "REJECTED",
    reason: "Credit score below the automated approval threshold.",
    explanation: {
      creditScore,
      creditThreshold: 720,
      creditPass,
      monthlyIncome: income,
      requestedAmount,
      maxAutoApprovalAmount,
      amountPass,
    },
  };
}

async function sealDecision(input) {
  const outcome = decide(input);
  const modelVersion = "loan-scorer-v1.3.0";

  const { evidence, recordId } = await cool.record({
    type: "loan.decision",
    metadata: {
      model: "loan-scorer",
      version: modelVersion,
      decision: outcome.decision,
    },
    payloads: {
      input: JSON.stringify(input),
      output: JSON.stringify(outcome),
    },
  });

  return {
    id: recordId,
    applicant: maskApplicant(input.applicantName),
    requestedAmount: input.requestedAmount,
    decision: outcome.decision,
    reason: outcome.reason,
    explanation: outcome.explanation,
    model: modelVersion,
    originalMetadataHash: evidence.record.event.metadata_hash,
    timestamp: new Date().toISOString(),
    evidence,
    tampered: false,
  };
}

app.post("/api/decide", async (req, res) => {
  try {
    const { applicantName, income, creditScore, requestedAmount } = req.body;
    if (
      !applicantName ||
      income == null ||
      creditScore == null ||
      requestedAmount == null
    ) {
      return res.status(400).json({
        error:
          "Missing applicantName, income, creditScore, or requestedAmount.",
      });
    }
    const record = await sealDecision({
      applicantName,
      income,
      creditScore,
      requestedAmount,
    });

    const db = await getDb();
    await db.collection("decisions").insertOne(record);

    res.json({
      id: record.id,
      applicant: record.applicant,
      decision: record.decision,
      reason: record.reason,
      explanation: record.explanation,
      model: record.model,
      timestamp: record.timestamp,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/decisions", async (req, res) => {
  try {
    const db = await getDb();
    const rows = await db
      .collection("decisions")
      .find({}, { projection: { evidence: 0, _id: 0 } })
      .sort({ timestamp: -1 })
      .toArray();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/receipt/:id", async (req, res) => {
  try {
    const db = await getDb();
    const record = await db
      .collection("decisions")
      .findOne({ id: req.params.id });
    if (!record) return res.status(404).json({ error: "Not found" });
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${record.id}.evidence.json"`,
    );
    res.json(record.evidence);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/receipt/:id/view", async (req, res) => {
  try {
    const db = await getDb();
    const record = await db
      .collection("decisions")
      .findOne({ id: req.params.id });
    if (!record) return res.status(404).json({ error: "Not found" });
    res.json(record.evidence);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/verify/:id", async (req, res) => {
  try {
    const db = await getDb();
    const record = await db
      .collection("decisions")
      .findOne({ id: req.params.id });
    if (!record) return res.status(404).json({ error: "Not found" });
    const verdict = await verifyEvidence(record.evidence);
    res.json(verdict);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tamper/:id", async (req, res) => {
  try {
    const db = await getDb();
    const record = await db
      .collection("decisions")
      .findOne({ id: req.params.id });
    if (!record) return res.status(404).json({ error: "Not found" });

    const ev = JSON.parse(JSON.stringify(record.evidence));
    const h = ev.record.event.metadata_hash;
    ev.record.event.metadata_hash =
      h.slice(0, -1) + (h.slice(-1) === "a" ? "b" : "a");

    await db
      .collection("decisions")
      .updateOne(
        { id: req.params.id },
        { $set: { evidence: ev, tampered: true } },
      );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/reset", async (req, res) => {
  try {
    const db = await getDb();
    await db.collection("decisions").deleteMany({});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/seed-demo", async (req, res) => {
  try {
    const scenarios = [
      {
        applicantName: "Vikram Salunkhe",
        income: 22000,
        creditScore: 590,
        requestedAmount: 400000,
      },
      {
        applicantName: "Sneha Kulkarni",
        income: 40000,
        creditScore: 671,
        requestedAmount: 180000,
      },
      {
        applicantName: "Rohan Deshmukh",
        income: 85000,
        creditScore: 762,
        requestedAmount: 300000,
      },
    ];
    const db = await getDb();
    const records = [];
    for (const s of scenarios) {
      records.push(await sealDecision(s));
    }
    await db.collection("decisions").insertMany(records);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Local dev only — on Vercel this file is imported as a serverless
// function and `app` is used directly as the request handler; Vercel
// sets VERCEL=1 in its build/runtime environment.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () =>
    console.log(`VerifAI Trail demo running on http://localhost:${PORT}`),
  );
}

export default app;
