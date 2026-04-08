const express = require('express');
const multer = require('multer');
const cors = require('cors');
const pdfParse = require('pdf-parse');
const sharp = require('sharp');
const { fromBuffer } = require('pdf2pic');
const fetch = require('node-fetch');

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 } // 150MB per file
});

const ANTHROPIC_KEY = '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';
const PROXY_URL = 'https://takeoffproxy.zach-c19.workers.dev';

app.use(cors());
app.use(express.json({ limit: '200mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Takeoff Mobile server running', version: '1.0.0' });
});

// Main takeoff endpoint
app.post('/takeoff', upload.fields([
  { name: 'pdfs', maxCount: 10 },
  { name: 'dwgs', maxCount: 10 }
]), async (req, res) => {
  try {
    const { jobName, gc, eng, options } = req.body;
    const pdfFiles = req.files?.pdfs || [];
    const dwgFiles = req.files?.dwgs || [];

    if (!pdfFiles.length) {
      return res.status(400).json({ error: 'No PDF files uploaded' });
    }

    console.log(`Processing takeoff: ${jobName} - ${pdfFiles.length} PDFs, ${dwgFiles.length} DWGs`);

    // Step 1: Extract text from PDFs
    let extractedText = '';
    const imageBuffers = [];

    for (const file of pdfFiles) {
      try {
        console.log(`Parsing PDF: ${file.originalname} (${Math.round(file.size/1024/1024*10)/10}MB)`);
        
        // Extract text
        const parsed = await pdfParse(file.buffer);
        extractedText += `\n\n=== FILE: ${file.originalname} ===\n${parsed.text}`;

        // Convert key pages to images (pages 1-6, covers most grading sets)
        const converter = fromBuffer(file.buffer, {
          density: 150,           // DPI - good quality without huge size
          saveFilename: 'page',
          savePath: '/tmp',
          format: 'jpeg',
          width: 1400,
          height: 1000,
          quality: 70
        });

        const pageCount = Math.min(parsed.numpages, 6);
        for (let i = 1; i <= pageCount; i++) {
          try {
            const result = await converter(i, { responseType: 'buffer' });
            if (result?.buffer) {
              // Compress further with sharp
              const compressed = await sharp(result.buffer)
                .jpeg({ quality: 65, progressive: true })
                .toBuffer();
              imageBuffers.push({
                name: file.originalname,
                page: i,
                data: compressed.toString('base64')
              });
              console.log(`  Page ${i}: ${Math.round(compressed.length/1024)}KB`);
            }
          } catch(pageErr) {
            console.warn(`  Could not render page ${i}:`, pageErr.message);
          }
        }
      } catch(pdfErr) {
        console.warn(`Could not process ${file.originalname}:`, pdfErr.message);
        // Still include filename in text even if parsing fails
        extractedText += `\n\n=== FILE: ${file.originalname} (could not parse) ===`;
      }
    }

    // Step 2: Build Claude message with text + images
    const checkedOptions = options ? JSON.parse(options) : [
      'Earthwork (cut, fill, net export)',
      'Pavement sections (HD/LD asphalt)',
      'Concrete flatwork',
      'Stripping and topsoil'
    ];

    const contentBlocks = [];

    // Add images first (Claude reads images before text)
    for (const img of imageBuffers) {
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: img.data
        }
      });
    }

    // Add extracted text
    if (extractedText.trim()) {
      contentBlocks.push({
        type: 'text',
        text: `EXTRACTED TEXT FROM PLAN SHEETS:\n${extractedText.slice(0, 15000)}` // Cap at 15k chars
      });
    }

    // Add the prompt
    contentBlocks.push({
      type: 'text',
      text: `You are an expert earthwork and civil construction estimator with 20+ years of experience.

Analyze these construction plan sheets for: "${jobName}" (GC: ${gc || 'unknown'}, Engineer: ${eng || 'unknown'})

CALCULATE: ${checkedOptions.join(', ')}

INSTRUCTIONS:
- Read finish floor elevations (FFE) from the plans
- Read existing and proposed contour lines to determine cut/fill
- Read building footprint SF from labels on plans
- Read pavement legend (HD asphalt, LD asphalt, concrete pavement areas)
- Look for grading notes, stripping depths (typically 6")
- Use scale bar to estimate areas not labeled
- Building pad SF is often labeled directly on the building footprint
- Site acreage is often in the legal description or title block
- Truck loads = net CY divided by 10 CY per load

Use actual numbers from the plans wherever visible. Make professional estimates where not shown.

Respond ONLY with this exact JSON structure — no markdown, no explanation:

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
  "notes": "<key observations string>",
  "confidence": "<'high', 'medium', or 'low'>"
}`
    });

    console.log(`Sending to Claude: ${imageBuffers.length} images + ${Math.round(extractedText.length/1000)}KB text`);

    // Step 3: Call Claude via Cloudflare proxy
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
