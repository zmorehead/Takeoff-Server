const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }
});

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const PROXY_URL = 'https://takeoffproxy.zach-c19.workers.dev';

app.use(cors());
app.use(express.json({ limit: '200mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'Takeoff Mobile server running', version: '2.0.0' });
});

app.post('/takeoff', upload.fields([
  { name: 'pdfs', maxCount: 10 },
  { name: 'dwgs', maxCount: 10 }
]), async (req, res) => {
  try {
    const { jobName, gc, eng, options } = req.body;
    const pdfFiles = req.files?.pdfs || [];

    if (!pdfFiles.length) {
      return res.status(400).json({ error: 'No PDF files uploaded' });
    }

    console.log(`Processing takeoff: ${jobName} - ${pdfFiles.length} PDFs`);

    const checkedOptions = options ? JSON.parse(options) : [
      'Earthwork (cut, fill, net export)',
      'Pavement sections (HD/LD asphalt)',
      'Concrete flatwork',
      'Stripping and topsoil'
    ];

    const contentBlocks = [];

    for (const file of pdfFiles.slice(0, 5)) {
      console.log(`Attaching PDF: ${file.originalname} (${Math.round(file.size/1024/1024*10)/10}MB)`);
      contentBlocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: file.buffer.toString('base64')
        }
      });
    }

    contentBlocks.push({
      type: 'text',
      text: `You are an expert earthwork and civil construction estimator with 20+ years of experience.

Analyze the attached PDF documents for job: "${jobName}" (GC: ${gc || 'unknown'}, Engineer: ${eng || 'unknown'})

IMPORTANT: Extract EXACT numbers directly from the documents. Do NOT estimate or guess — read the actual values printed in the plans, volume reports, quantity tables, or notes.

If this is a volume report (like an Agtek or similar report), read the exact totals from the summary table.
If these are plan sheets, read the quantities from the grading plans, quantity tables, and notes.

EXTRACT THESE ITEMS: ${checkedOptions.join(', ')}

READ THESE SPECIFIC VALUES:
- Cut CY: total cut cubic yards from the volume summary
- Fill CY: total fill cubic yards from the volume summary
- Net CY: absolute difference between cut and fill
- Site type: "export" if cut > fill, "import" if fill > cut
- Stripping CY: topsoil stripping volume (often labeled "site strip" or "stripping")
- HD Asphalt SY: heavy duty asphalt area in square yards
- LD Asphalt SY: light duty asphalt area in square yards
- Concrete pavement SY: concrete pavement area in square yards
- Concrete walks SF: sidewalk/walk area in square feet
- Building pad CY: building pad cut/fill volume
- Building pad SF: total building footprint square footage
- Site acres: total site area in acres (divide total SF by 43,560)
- FFE: finish floor elevation(s)

Respond ONLY with this exact JSON — no markdown, no explanation, exact numbers only:

{
  "siteAcres": <number>,
  "buildingPadSF": <number>,
  "ffe": "<string>",
  "siteType": "<'export' or 'import'>",
  "cutCY": <number>,
  "fillCY": <number>,
  "netCY": <number>,
  "strippingCY": <number>,
  "hdAsphaltSY": <number>,
  "ldAsphaltSY": <number>,
  "concretePaveSY": <number>,
  "concreteWalksSF": <number>,
  "buildingPadCY": <number>,
  "notes": "<what documents were found and key observations>",
  "confidence": "<'high' if exact numbers found, 'medium' if some estimated, 'low' if mostly estimated>"
}`
    });

    const claudeResponse = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: contentBlocks }]
      })
    });

    const claudeData = await claudeResponse.json();
    
    if (claudeData.error) {
      throw new Error('Claude error: ' + JSON.stringify(claudeData.error));
    }

    const rawText = claudeData.content.map(b => b.text || '').join('');
    const clean = rawText.replace(/```json|```/g, '').trim();
    
    let quantities;
    try {
      quantities = JSON.parse(clean);
    } catch(parseErr) {
      console.error('Could not parse Claude response:', clean);
      throw new Error('Could not parse AI response — please try again');
    }

    console.log(`Takeoff complete for ${jobName}:`, quantities);
    res.json({ success: true, quantities });

  } catch (err) {
    console.error('Takeoff error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Takeoff Mobile server running on port ${PORT}`);
});
