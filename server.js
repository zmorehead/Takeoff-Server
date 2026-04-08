const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const pdfParse = require('pdf-parse');

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }
});

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

app.use(cors());
app.use(express.json({ limit: '200mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'Takeoff Mobile server running', version: '3.0.0' });
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

    // Extract text from all PDFs
    let extractedText = '';
    for (const file of pdfFiles) {
      try {
        console.log(`Extracting text from: ${file.originalname}`);
        const parsed = await pdfParse(file.buffer);
        extractedText += `\n\n=== FILE: ${file.originalname} ===\n${parsed.text}`;
        console.log(`  Extracted ${parsed.text.length} characters`);
      } catch(e) {
        console.warn(`Could not parse ${file.originalname}:`, e.message);
        extractedText += `\n\n=== FILE: ${file.originalname} (could not parse) ===`;
      }
    }

    const prompt = `You are an expert earthwork and civil construction estimator with 20+ years of experience.

Analyze the following extracted text from construction documents for job: "${jobName}" (GC: ${gc || 'unknown'}, Engineer: ${eng || 'unknown'})

IMPORTANT: Extract EXACT numbers directly from the text. Do NOT estimate — read the actual values from the volume reports, quantity tables, and notes.

If this is a volume report (Agtek, Carlson, etc.), read the exact totals from the summary table.
If these are plan sheets, read quantities from quantity tables and grading notes.

EXTRACT THESE ITEMS: ${checkedOptions.join(', ')}

READ THESE SPECIFIC VALUES:
- Cut CY: total cut cubic yards from the volume summary (look for "Regions Total" or similar)
- Fill CY: total fill cubic yards from the volume summary
- Net CY: absolute difference between cut and fill
- Site type: "export" if cut > fill, "import" if fill > cut
- Stripping CY: topsoil stripping volume (look for "Site Strip" or "Stripping")
- HD Asphalt SY: heavy duty asphalt in square yards (look for "HD" rows)
- LD Asphalt SY: light duty asphalt in square yards (look for "LD" rows)
- Concrete pavement SY: concrete pavement in square yards
- Concrete walks SF: sidewalk area in square feet (look for "Walk" rows, convert SY to SF by x9)
- Building pad CY: building pad volume (look for "Building 5", "Building 6" etc.)
- Building pad SF: total building footprint SF (sum all building areas)
- Site acres: total site area (divide total SF by 43,560)
- FFE: finish floor elevation(s) if shown

EXTRACTED DOCUMENT TEXT:
${extractedText}

Respond ONLY with this exact JSON — no markdown, no explanation:

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
  "notes": "<key observations>",
  "confidence": "<'high' if exact numbers found, 'medium' if some estimated, 'low' if mostly estimated>"
}`;

    console.log(`Sending ${extractedText.length} characters of text to Claude...`);

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
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
