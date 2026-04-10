const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }
});

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const RAILWAY_URL = 'https://takeoff-server-production.up.railway.app';

app.use(cors());
app.use(express.json({ limit: '200mb' }));

// ─── HELPER: call Claude directly from Railway ────────────────────────
async function callClaude(messages, maxTokens = 1500) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages
    })
  });
  const data = await response.json();
  if (data.error) throw new Error('Claude error: ' + JSON.stringify(data.error));
  return data.content.map(b => b.text || '').join('');
}

// ─── HELPER: extract text from PDF buffer ────────────────────────────
async function extractText(buffer, filename) {
  try {
    const parsed = await pdfParse(buffer);
    return `\n\n=== FILE: ${filename} ===\n${parsed.text}`;
  } catch(e) {
    return `\n\n=== FILE: ${filename} (could not parse) ===`;
  }
}

// ─── HEALTH CHECK ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Takeoff Mobile server running', version: '3.0.0' });
});

// ─── 1. MAIN TAKEOFF ─────────────────────────────────────────────────
app.post('/takeoff', upload.fields([
  { name: 'pdfs', maxCount: 10 },
  { name: 'dwgs', maxCount: 10 }
]), async (req, res) => {
  try {
    const { jobName, gc, eng, options } = req.body;
    const pdfFiles = req.files?.pdfs || [];
    if (!pdfFiles.length) return res.status(400).json({ error: 'No PDF files uploaded' });

    console.log(`Takeoff: ${jobName} - ${pdfFiles.length} PDFs`);
    const checkedOptions = options ? JSON.parse(options) : ['Earthwork','Pavement','Concrete','Stripping'];

    let extractedText = '';
    for (const file of pdfFiles) {
      extractedText += await extractText(file.buffer, file.originalname);
    }

    const prompt = `You are an expert earthwork and civil construction estimator with 20+ years of experience.

Analyze the following extracted text from construction documents for job: "${jobName}" (GC: ${gc || 'unknown'}, Engineer: ${eng || 'unknown'})

IMPORTANT: Extract EXACT numbers directly from the documents. Do NOT estimate — read the actual values from the volume reports, quantity tables, and notes.

EXTRACT THESE ITEMS: ${checkedOptions.join(', ')}

READ THESE SPECIFIC VALUES:
- Cut CY: total cut cubic yards from the volume summary
- Fill CY: total fill cubic yards
- Net CY: absolute difference between cut and fill
- Site type: "export" if cut > fill, "import" if fill > cut
- Stripping CY: topsoil stripping volume
- HD Asphalt SY, LD Asphalt SY, Concrete pavement SY, Concrete walks SF
- Building pad CY and SF, Site acres, FFE

EXTRACTED DOCUMENT TEXT:
${extractedText.slice(0, 20000)}

Respond ONLY with this exact JSON — no markdown:
{
  "siteAcres": <number>, "buildingPadSF": <number>, "ffe": "<string>",
  "siteType": "<'export' or 'import'>", "cutCY": <number>, "fillCY": <number>,
  "netCY": <number>, "strippingCY": <number>, "hdAsphaltSY": <number>,
  "ldAsphaltSY": <number>, "concretePaveSY": <number>, "concreteWalksSF": <number>,
  "buildingPadCY": <number>, "notes": "<key observations>",
  "confidence": "<'high', 'medium', or 'low'>"
}`;

    const raw = await callClaude([{ role: 'user', content: prompt }]);
    const quantities = JSON.parse(raw.replace(/```json|```/g, '').trim());
    console.log(`Takeoff complete: ${jobName}`);
    res.json({ success: true, quantities });
  } catch(err) {
    console.error('Takeoff error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 2. BID LETTER ───────────────────────────────────────────────────
app.post('/bid-letter', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { r, jobName, gc, eng, today } = req.body;
    const isExport = r.siteType === 'export';
    const prompt = `Write a professional bid letter from an earthwork contractor to a general contractor.

Job: ${jobName} | GC: ${gc||'[GC Name]'} | Engineer: ${eng||'not specified'} | Date: ${today}

Quantities: ${isExport?'Export':'Import'} site · Net ${(r.netCY||0).toLocaleString()} CY · ~${Math.round((r.netCY||0)/10).toLocaleString()} truck loads
Cut: ${(r.cutCY||0).toLocaleString()} CY · Fill: ${(r.fillCY||0).toLocaleString()} CY · Stripping: ${(r.strippingCY||0).toLocaleString()} CY
HD Asphalt: ${(r.hdAsphaltSY||0).toLocaleString()} SY · LD Asphalt: ${(r.ldAsphaltSY||0).toLocaleString()} SY
Concrete pave: ${(r.concretePaveSY||0).toLocaleString()} SY · Building pad: ${(r.buildingPadSF||0).toLocaleString()} SF
FFE: ${r.ffe||'not specified'} · Confidence: ${r.confidence||'medium'}
AI notes: ${r.notes||'none'}

Write a 3-4 paragraph professional bid letter. Include: introduction stating we are pleased to submit our bid, summary of earthwork scope based on quantities, note about our site work and earthmoving capabilities, mention CTP Topography drone survey verification if needed, and professional closing. Leave blank line for bid total. Keep concise and professional. No markdown.`;

    const letter = await callClaude([{ role: 'user', content: prompt }], 800);
    res.json({ success: true, letter });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 3. SCOPE CHECKLIST ──────────────────────────────────────────────
app.post('/scope-checklist', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { r, jobName } = req.body;
    const prompt = `You are an expert earthwork contractor reviewing a set of plans. Generate a scope checklist for estimators.

Job: ${jobName}
Quantities: Cut ${(r.cutCY||0).toLocaleString()} CY, Fill ${(r.fillCY||0).toLocaleString()} CY, Net ${(r.netCY||0).toLocaleString()} CY, Stripping ${(r.strippingCY||0).toLocaleString()} CY, HD Asphalt ${(r.hdAsphaltSY||0).toLocaleString()} SY, LD Asphalt ${(r.ldAsphaltSY||0).toLocaleString()} SY, Concrete ${(r.concretePaveSY||0).toLocaleString()} SY, Building pad ${(r.buildingPadSF||0).toLocaleString()} SF
AI notes: ${r.notes||'none'}

Return ONLY a JSON array — no markdown:
[{"item":"description","priority":"required|verify|standard","category":"earthwork|pavement|erosion|utility|general"}]
Include 12-18 items covering earthwork scope, erosion control, utilities, pavement, building pad, mobilization, permits, traffic control.`;

    const raw = await callClaude([{ role: 'user', content: prompt }], 1000);
    const items = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ success: true, items });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 4. PLAN COMPARISON ──────────────────────────────────────────────
app.post('/compare', upload.fields([
  { name: 'orig', maxCount: 1 },
  { name: 'rev', maxCount: 1 }
]), async (req, res) => {
  try {
    const { jobName, revDesc, origName, revName } = req.body;
    const origFile = req.files?.orig?.[0];
    const revFile = req.files?.rev?.[0];
    if (!origFile || !revFile) return res.status(400).json({ error: 'Both files required' });

    console.log(`Compare: ${jobName} - ${origFile.originalname} vs ${revFile.originalname}`);

    const origText = await extractText(origFile.buffer, origFile.originalname);
    const revText = await extractText(revFile.buffer, revFile.originalname);

    const prompt = `You are an expert construction plan reviewer comparing TWO versions of plans.

Job: "${jobName}" | Revision: ${revDesc}
DOCUMENT 1 (Original — ${origName}):
${origText.slice(0, 10000)}

DOCUMENT 2 (Revised — ${revName}):
${revText.slice(0, 10000)}

Identify EVERY difference. Look for: FFE changes, quantity changes, grading note changes, pavement section changes, building footprint changes, site acreage changes, stripping requirements, utility changes, drainage changes, erosion control changes, sheet additions/removals, specification changes.

Return ONLY this JSON — no markdown:
{
  "summary": "<one sentence>",
  "totalChanges": <number>,
  "criticalCount": <number>,
  "changes": [{"type":"modified|added|removed|warning","category":"earthwork|pavement|elevation|scope|structural|utility|drainage|general","title":"<short title>","detail":"<specific description>","oldValue":"<or null>","newValue":"<or null>","bidImpact":"high|medium|low|unknown","bidImpactNote":"<brief note>"}],
  "noBidImpactItems": ["<minor changes>"],
  "recommendation": "<estimator recommendation>"
}`;

    const raw = await callClaude([{ role: 'user', content: prompt }], 2000);
    const report = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ success: true, report });
  } catch(err) {
    console.error('Compare error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 5. SUB BID COMPARISON ───────────────────────────────────────────
app.post('/sub-compare', upload.fields([
  { name: 'bids', maxCount: 5 }
]), async (req, res) => {
  try {
    const { jobName, scope } = req.body;
    const bidFiles = req.files?.bids || [];
    if (bidFiles.length < 2) return res.status(400).json({ error: 'At least 2 bid files required' });

    console.log(`Sub compare: ${jobName} - ${bidFiles.length} bids`);

    let allText = '';
    for (let i = 0; i < bidFiles.length; i++) {
      const text = await extractText(bidFiles[i].buffer, bidFiles[i].originalname);
      allText += `\n\n======= SUB ${i+1}: ${bidFiles[i].originalname} =======\n${text}`;
    }

    const prompt = `You are an expert construction bid leveling specialist comparing ${bidFiles.length} subcontractor bids.

Job: "${jobName}" | Scope: "${scope}"

${allText.slice(0, 25000)}

Read each bid and extract line items, quantities, unit prices, totals. Return ONLY this JSON — no markdown:
{
  "jobName": "${jobName}", "scope": "${scope}",
  "subs": [{"name":"Sub 1","company":"name if visible","totalBid":0,"lineItems":[{"item":"","qty":"","unit":"","unitPrice":0,"total":0}],"inclusions":[],"exclusions":[],"notes":""}],
  "commonLineItems": [], "scopeGaps": [{"item":"","missingFrom":[],"note":""}],
  "recommendation": "", "lowestBid": "Sub X", "highestBid": "Sub X", "averageBid": 0
}`;

    const raw = await callClaude([{ role: 'user', content: prompt }], 3000);
    const report = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ success: true, report });
  } catch(err) {
    console.error('Sub compare error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 6. CHANGE ORDER ─────────────────────────────────────────────────
app.post('/change-order', upload.single('co'), async (req, res) => {
  try {
    const { jobName, gc, contractVal } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    console.log(`Change order: ${jobName}`);
    const text = await extractText(req.file.buffer, req.file.originalname);

    const prompt = `You are an expert construction estimator reviewing a change order.

Job: "${jobName}" | GC: "${gc||'GC'}" | Original contract: ${contractVal||'unknown'}

CHANGE ORDER DOCUMENT:
${text.slice(0, 15000)}

Return ONLY this JSON — no markdown:
{
  "coNumber": "", "coDate": "", "summary": "",
  "totalCostImpact": 0, "totalDaysImpact": 0,
  "items": [{"type":"add|remove|modify","description":"","quantity":"","unitPrice":0,"totalCost":0,"daysImpact":0,"notes":""}],
  "justification": "", "negotiationPoints": [], "recommendedResponse": "",
  "responseLetter": "<3-paragraph professional response letter>"
}`;

    const raw = await callClaude([{ role: 'user', content: prompt }], 2000);
    const report = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ success: true, report });
  } catch(err) {
    console.error('Change order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 7. GEOTECH READER ───────────────────────────────────────────────
app.post('/geotech', upload.single('geo'), async (req, res) => {
  try {
    const { jobName, eng } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    console.log(`Geotech: ${jobName}`);
    const text = await extractText(req.file.buffer, req.file.originalname);

    const prompt = `You are an expert earthwork contractor reviewing a geotechnical report for bidding purposes.

Job: "${jobName}" | Engineering firm: "${eng||'Engineering firm'}"

GEOTECHNICAL REPORT:
${text.slice(0, 20000)}

Extract EVERY number and specification that affects earthwork bidding. Return ONLY this JSON — no markdown:
{
  "reportDate": "", "projectLocation": "",
  "soilProfile": [{"depth":"","soilType":"","description":"","uscs":""}],
  "groundwaterDepth": "", "rockDepth": "",
  "compactionSpecs": {
    "generalFill": {"proctor":"","minCompaction":""},
    "buildingPad": {"proctor":"","minCompaction":""},
    "pavementSubgrade": {"proctor":"","minCompaction":""}
  },
  "shrinkSwellFactors": {"shrinkFactor":"","swellFactor":"","notes":""},
  "bearingCapacity": {"allowable":"","notes":""},
  "overExcavation": {"required":false,"depth":"","reason":""},
  "specialRequirements": [],
  "pavementRecommendations": {"hdSection":"","ldSection":""},
  "boringLocations": [],
  "bidWarnings": [],
  "estimatorSummary": "<2-3 sentence plain English summary>"
}`;

    const raw = await callClaude([{ role: 'user', content: prompt }], 2000);
    const report = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json({ success: true, report });
  } catch(err) {
    console.error('Geotech error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 8. QUANTITY READER (Agtek / STACK PDF auto-fill) ────────────────
app.post('/read-quantities', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    console.log(`Reading quantities from: ${req.file.originalname}`);
    const text = await extractText(req.file.buffer, req.file.originalname);

    const prompt = `You are an expert earthwork estimator reading a takeoff software report (Agtek, STACK, Earthworks, or similar).

Extract every quantity from this document. Read EXACT numbers — do not estimate.

DOCUMENT TEXT:
${text.slice(0, 20000)}

Look for:
- Job name, project name, or site name
- General contractor / owner name
- Engineer or design firm
- Bid due date
- Cut cubic yards (CY) — may be labeled "Cut", "Excavation", "Earth Cut"
- Fill cubic yards (CY) — may be labeled "Fill", "Embankment", "Earth Fill"
- Net CY — difference between cut and fill (positive number)
- Site type — "export" if cut > fill, "import" if fill > cut
- Stripping CY — topsoil stripping volume
- HD Asphalt SY — heavy duty asphalt pavement square yards
- LD Asphalt SY — light duty asphalt pavement square yards
- Concrete pavement SY
- Concrete walks or flatwork SF
- Building pad SF and/or CY
- Site acres
- Finish floor elevation (FFE)
- Any notes or scope qualifications

Return ONLY this JSON — no markdown, no explanation:
{
  "jobName": "<project name or empty string>",
  "gc": "<GC or owner name or empty string>",
  "eng": "<engineer or empty string>",
  "dueDate": "<bid due date or empty string>",
  "siteType": "<'export' or 'import'>",
  "cutCY": <number or 0>,
  "fillCY": <number or 0>,
  "netCY": <number or 0>,
  "strippingCY": <number or 0>,
  "hdAsphaltSY": <number or 0>,
  "ldAsphaltSY": <number or 0>,
  "concretePaveSY": <number or 0>,
  "concreteWalksSF": <number or 0>,
  "buildingPadSF": <number or 0>,
  "buildingPadCY": <number or 0>,
  "siteAcres": <number or 0>,
  "ffe": "<FFE value or empty string>",
  "notes": "<any scope notes, assumptions, or qualifications found in the document>",
  "confidence": "<'high' if quantities clearly labeled, 'medium' if inferred, 'low' if document unclear>"
}`;

    const raw = await callClaude([{ role: 'user', content: prompt }], 1000);
    const quantities = JSON.parse(raw.replace(/```json|```/g, '').trim());
    console.log(`Quantities read from ${req.file.originalname}:`, quantities);
    res.json({ success: true, quantities });
  } catch(err) {
    console.error('Read quantities error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Takeoff Mobile server v3.0 running on port ${PORT}`));
