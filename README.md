# VerifAI Trail

A compliance evidence layer for AI-driven lending decisions in Indian BFSI, built on the
**CooL SDK** (`cool-nwc`) and backed by MongoDB.

This is a working prototype — every "Verify" and "Simulate tamper" action calls the real CooL
SDK (`cool.record()`, `verifyEvidence()`), with real hybrid ML-DSA-65 + Ed25519 signatures and a
real RFC 6962 transparency log underneath. Nothing about the verification logic is hardcoded or
faked.

## The problem this solves

AI now approves loans, flags fraud, and triages claims across Indian BFSI. Regulators — RBI's
FREE-AI framework (Aug 2025) — are moving toward requiring audit trails and independent
validation for these decisions, and several of its provisions are proposed for incorporation into
binding RBI Master Directions. At the same time, the DPDP Act 2023 restricts how long personal
data can be retained. Most companies can only satisfy one side of that at a time: keep detailed
logs (a privacy and breach-liability risk), or keep clean data (no audit trail to show a regulator
or a disputing customer).

Ordinary application logs don't solve this either way — a log line can be edited after the fact,
and a screenshot proves nothing about what a model actually did.

## What we built

A loan-decisioning demo with a compliance dashboard on top:

1. A simple rule-based loan decision engine approves, rejects, or flags applications for manual
   review.
2. The moment a decision is made, it's sealed with `cool.record()` — the applicant's actual data
   (name, income, credit score, the decision output) is committed as a **salted hash and
   discarded**. Only the hash and a signed receipt persist; the plaintext never touches storage.
3. A compliance dashboard ("Evidence Ledger") lists every decision by a masked applicant ID, with
   a **Verify** button that runs the real CooL verifier and shows its full 7-domain verdict
   (binding, signature, inclusion, witnesses, attestation, enclave, anchor) — not a single fake
   green tick.
4. A **Simulate tamper** button flips one hex digit in the stored receipt — exactly like CooL's
   own tamper demo — and re-verifying immediately shows `FAILED` with the exact cryptographic
   reason. This is the pitch made tangible: nobody can quietly edit a decision after the fact
   without the tamper being provable.
5. A **View receipt** / **Download** pair shows or exports the raw `cool.receipt.v2` JSON — the
   artifact an auditor or regulator would actually be handed.
6. A **Seed demo data** button instantly creates one of each outcome, for a fast, typo-free live
   demo.

## How the CooL SDK is used — and why it's essential, not decorative

CooL isn't bolted on as an afterthought; it's the entire mechanism that makes the pitch true:

| Round-1 claim | CooL feature that actually delivers it |
| --- | --- |
| "Prove a decision wasn't altered after the fact" | `cool.record()`'s binding hash + hybrid ML-DSA-65 + Ed25519 signature over canonical CBOR — this is what `verifyEvidence()` checks, and what `/api/tamper/:id` demonstrably breaks |
| "Prove which model/version ran" | The `metadata` passed to `record()` (model name, version, decision) is committed and signed as part of the receipt |
| "Never store the customer's actual data" | Every `payloads` value (the applicant's raw input/output) is committed as a **salted SHA-256 hash and discarded** by the SDK itself — we never see plaintext again after the `record()` call returns |
| "Nothing was quietly deleted or inserted into the log after the fact" | The RFC 6962 transparency log + inclusion proof, checked under `inclusion` in every verdict |
| "Anyone can check this independently, without trusting us" | `verifyEvidence()` runs entirely offline against the receipt JSON — no CooL account, no network call, no access to our database |

Without CooL, this app would just be a rule-based loan approver with a normal, editable database
row per decision — i.e. exactly the unprovable status quo the pitch argues is the problem. CooL is
what turns "trust us" into "check for yourself."

## Why MongoDB

The Round 1 in-memory version lost every decision on restart, which is fine for a local demo but
breaks completely on a serverless platform like Vercel, where a fresh function instance can spin
up for any request. MongoDB (Atlas free tier) gives the Evidence Ledger actual persistence:
decisions and their receipts survive restarts, cold starts, and redeploys, the way a real
compliance record store would need to.

Note what MongoDB is **not** used for here: it never stores the applicant's raw data. It stores
exactly what the CooL receipt already exposes — masked applicant labels, decision outcomes, and
the signed evidence JSON (itself already scrubbed of plaintext by CooL). The privacy property
comes from CooL's `record()` call, not from anything we do at the database layer.

## Architecture / workflow

```
                     ┌─────────────────────┐
   POST /api/decide  │   Express app        │
   ───────────────▶  │   (api/index.js)     │
                     │                      │
                     │  1. decide()         │  rule-based approve / review / reject
                     │  2. cool.record()    │  ← CooL SDK: commit + sign + (simulated) attest
                     │  3. db.insertOne()   │  ← MongoDB: persist the receipt + metadata
                     └─────────┬────────────┘
                               │
                     ┌─────────▼────────────┐
                     │   MongoDB Atlas       │  decisions collection:
                     │   (decisions coll.)   │  { id, applicant(masked), decision,
                     └─────────┬────────────┘    model, timestamp, evidence, tampered }
                               │
   GET /api/decisions          │
   POST /api/verify/:id  ──────┤  verifyEvidence(evidence) → 7-domain verdict
   POST /api/tamper/:id  ──────┤  flips one hex digit, re-persists, next verify fails
   GET  /api/receipt/:id ──────┘  returns the raw cool.receipt.v2 JSON

                     ┌──────────────────────┐
   Browser  ◀────────│  /public (static)     │  dashboard UI — served directly by
                     │  index.html/app.js/   │  Vercel's static hosting, not through
                     │  styles.css           │  the function, for every non-/api path
                     └──────────────────────┘
```

`vercel.json` rewrites only `/api/(.*)` into the single serverless function at `api/index.js`;
everything else (`/`, `/app.js`, `/styles.css`) is served as a static asset directly by Vercel.

## Technical decisions worth knowing

- **Single Express app as one serverless function**, not one function per route. Simpler to
  reason about, and avoids paying a MongoDB connection-pool cost per route on Vercel's per-file
  function model.
- **Cached MongoDB connection at module scope** (`api/db.js`) rather than opening a new
  `MongoClient` per request — required on serverless, where a warm function instance should reuse
  its connection rather than exhausting Atlas's connection limit.
- **Projection on `GET /api/decisions`** explicitly excludes the `evidence` field so the ledger
  list stays small; the full receipt is only fetched on demand via `/api/receipt/:id`.
- **The decision engine is deliberately simple** (single credit-score threshold) — the point of
  this build is the evidence layer, not a realistic underwriting model.
- **Attestation and enclave checks report `simulated`**, because this doesn't run inside a real
  Intel TDX enclave (that needs Phala's `dstack` and real confidential-computing hardware). CooL
  is explicit about this in its own verdicts — it never reports `pass` on a check it can't
  actually perform, and neither does this app's UI.

## Limitations and future improvements

- **No authentication** — anyone with the URL can see the Evidence Ledger. A real deployment
  needs role-based access (e.g. only compliance officers can view; only the decision engine's
  service account can write).
- **No real TEE attestation** — deploying the evidence-generation step inside a `dstack` TDX
  enclave would turn the `attestation`/`enclave` verdict checks from `simulated` to `pass`,
  closing the last gap in the "was this run in an approved environment" claim.
- **Decision engine is a toy** — a real deployment would call an actual underwriting model, with
  `cool.record()` wrapping its real input/output rather than a synthetic rule.
- **No independent transparency witnesses** — the RFC 6962 log's signed tree head is self-signed
  by this deployment; production would want external witnesses/gossip (on CooL's own roadmap) so
  the log's own operator can't quietly rewrite history either.
- **Single MongoDB collection, no indices** — fine at demo scale; production would add an index
  on `id` and probably a TTL/archival policy for old receipts.
- **No pagination** on `/api/decisions` — fine for a demo, would need it at real volume.

## Running it locally

```bash
npm install
cp .env.example .env   # then fill in your MongoDB Atlas connection string
npm start
```

Open `http://localhost:4000`. Use the "Seed demo data" button, or the three "Quick fill" presets,
to generate approve/review/reject scenarios without typing numbers by hand.

## MongoDB setup (free, ~5 minutes)

1. Create a free cluster at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register).
2. Under **Database Access**, create a user with a password.
3. Under **Network Access**, allow access from anywhere (`0.0.0.0/0`) — fine for a hackathon demo.
4. Under **Connect → Drivers**, copy the connection string and put it in `.env` (locally) or in
   Vercel's Environment Variables (for deployment) as `MONGODB_URI`.

## Deploying to Vercel

1. Push this repo to GitHub.
2. On [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. Vercel auto-detects the `/api` function and `/public` static folder — no build command needed.
4. Under **Settings → Environment Variables**, add `MONGODB_URI` (and optionally `MONGODB_DB`).
5. Deploy. You'll get a `https://your-app.vercel.app` URL that works exactly like local dev, with
   persistence now backed by Atlas instead of memory.

## Files

- `api/index.js` — the Express app: decision engine + all CooL SDK integration points
  (`record`, `verify`, tamper simulation) + all MongoDB reads/writes. Deployed as a single
  serverless function on Vercel; also runnable directly with `node api/index.js` for local dev.
- `api/db.js` — cached MongoDB connection helper.
- `public/` — the compliance dashboard (vanilla HTML/CSS/JS, no build step, no framework).
- `vercel.json` — routes `/api/*` to the function; everything else is static.
