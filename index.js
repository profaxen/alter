require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { PDFParse } = require("pdf-parse");
const Tesseract = require("tesseract.js");
const PDFDocument = require("pdfkit");

// ============================================================
//  CONFIG
// ============================================================
const TELEGRAM_MSG_LIMIT = 4096;
const MAX_RESUME_TEXT_LEN = 6000;
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_MAX_TOKENS = 2048;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
console.log("✅ Bot is running...");

// ============================================================
//  SESSION STORE
// ============================================================
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, { state: "IDLE" });
  return sessions.get(chatId);
}
function resetSession(chatId) {
  sessions.set(chatId, { state: "IDLE" });
}

// ============================================================
//  HELPERS
// ============================================================

function tempFilePath(ext) {
  return path.join(os.tmpdir(), `resume_${crypto.randomUUID()}${ext}`);
}

async function downloadFile(fileUrl) {
  console.log(`⬇️  Downloading: ${fileUrl}`);
  const r = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 30000 });
  console.log(`✅ Downloaded ${r.data.byteLength} bytes`);
  return Buffer.from(r.data);
}

// ---- pdf-parse v2 API ----
async function extractPDF(buffer) {
  console.log("📄 Extracting PDF text (v2 API)...");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text || "").trim();
    console.log(`✅ PDF: ${text.length} chars`);
    return text;
  } finally {
    await parser.destroy();
  }
}

async function extractImage(filePath) {
  console.log("🖼️  Running OCR...");
  const result = await Tesseract.recognize(filePath, "eng");
  const text = (result.data.text || "").trim();
  console.log(`✅ OCR: ${text.length} chars`);
  return text;
}

function splitMessage(text, limit = TELEGRAM_MSG_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  return chunks;
}

async function sendLong(chatId, text) {
  for (const chunk of splitMessage(text)) {
    await bot.sendMessage(chatId, chunk);
  }
}

// ============================================================
//  GROQ AI — ATS ANALYSIS
// ============================================================
async function analyzeResume(resumeText, jobDescription) {
  const resume = resumeText.substring(0, MAX_RESUME_TEXT_LEN);
  const jd = jobDescription.substring(0, 3000);
  console.log(`🤖 Groq ATS analysis (resume: ${resume.length}, JD: ${jd.length} chars)...`);

  const prompt = `You are a senior HR recruiter and ATS (Applicant Tracking System) expert.

I will give you a JOB DESCRIPTION and a CANDIDATE'S RESUME. Analyze how well the resume matches the job.

--- JOB DESCRIPTION ---
${jd}
--- END JOB DESCRIPTION ---

--- RESUME ---
${resume}
--- END RESUME ---

Respond in EXACTLY this format:

📊 **ATS SCORE: [X]/100**

🔍 **SCORE BREAKDOWN:**
• Keyword Match: [X]/25
• Skills Alignment: [X]/25
• Experience Relevance: [X]/20
• Formatting & Structure: [X]/15
• Education & Certs: [X]/15

⚠️ **MISSING KEYWORDS:**
[List 5-8 important keywords from the JD missing from resume]

💡 **TOP IMPROVEMENTS:**
1. [Most impactful change]
2. [Second change]
3. [Third change]
4. [Fourth change]
5. [Fifth change]

📝 **IMPROVED PROFESSIONAL SUMMARY:**
[3-4 sentence summary tailored to this JD]

📋 **IMPROVED KEY SKILLS:**
[8-12 skills optimized for this JD]

💼 **IMPROVED EXPERIENCE BULLETS:**
[3-5 bullet points with keywords from JD, quantified with metrics]

Be concise and actionable.`;

  const response = await axios.post(GROQ_URL, {
    model: GROQ_MODEL, max_tokens: GROQ_MAX_TOKENS, temperature: 0.4,
    messages: [{ role: "user", content: prompt }],
  }, {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    timeout: 60000,
  });

  const reply = response.data.choices?.[0]?.message?.content;
  if (!reply) throw new Error("Groq returned empty");
  console.log(`✅ ATS analysis: ${reply.length} chars`);
  return reply;
}

// ============================================================
//  GROQ AI — GENERATE IMPROVED RESUME CONTENT
// ============================================================
async function generateImprovedResume(resumeText, jobDescription) {
  const resume = resumeText.substring(0, MAX_RESUME_TEXT_LEN);
  const jd = jobDescription.substring(0, 3000);
  console.log("🤖 Generating improved resume...");

  const prompt = `You are a professional resume writer. Given the JOB DESCRIPTION and RESUME below, create an improved version optimized for this job.

--- JOB DESCRIPTION ---
${jd}
--- END JOB DESCRIPTION ---

--- ORIGINAL RESUME ---
${resume}
--- END ORIGINAL RESUME ---

Return the improved resume in this EXACT structured format (use these exact headers, one per line):

FULL_NAME: [Candidate's full name]
TITLE: [Professional title aligned to the job]
EMAIL: [email if found, otherwise "N/A"]
PHONE: [phone if found, otherwise "N/A"]
LINKEDIN: [LinkedIn URL if found, otherwise "N/A"]
LOCATION: [location if found, otherwise "N/A"]

SUMMARY:
[3-4 sentence professional summary tailored to the JD]

SKILLS:
[Comma-separated list of 10-15 relevant skills]

EXPERIENCE:
[COMPANY_1] | [ROLE_1] | [DATES_1]
- [Achievement bullet with metrics]
- [Achievement bullet with metrics]
- [Achievement bullet with metrics]

[COMPANY_2] | [ROLE_2] | [DATES_2]
- [Achievement bullet with metrics]
- [Achievement bullet with metrics]

EDUCATION:
[DEGREE] | [INSTITUTION] | [YEAR]

CERTIFICATIONS:
[List certifications, or "N/A"]

Keep all information factual based on the original resume. Only improve wording and add keywords from JD.`;

  const response = await axios.post(GROQ_URL, {
    model: GROQ_MODEL, max_tokens: GROQ_MAX_TOKENS, temperature: 0.3,
    messages: [{ role: "user", content: prompt }],
  }, {
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    timeout: 60000,
  });

  const reply = response.data.choices?.[0]?.message?.content;
  if (!reply) throw new Error("Groq returned empty improved resume");
  console.log(`✅ Improved resume: ${reply.length} chars`);
  return reply;
}

// ============================================================
//  PREMIUM PDF GENERATION (pdfkit)
// ============================================================
function parseResumeContent(raw) {
  const lines = raw.split("\n").map((l) => l.trim());
  const data = {
    fullName: "Candidate", title: "", email: "", phone: "", linkedin: "", location: "",
    sections: {},
  };
  let currentSection = null;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("FULL_NAME:")) { data.fullName = line.replace("FULL_NAME:", "").trim(); continue; }
    if (line.startsWith("TITLE:")) { data.title = line.replace("TITLE:", "").trim(); continue; }
    if (line.startsWith("EMAIL:")) { data.email = line.replace("EMAIL:", "").trim(); continue; }
    if (line.startsWith("PHONE:")) { data.phone = line.replace("PHONE:", "").trim(); continue; }
    if (line.startsWith("LINKEDIN:")) { data.linkedin = line.replace("LINKEDIN:", "").trim(); continue; }
    if (line.startsWith("LOCATION:")) { data.location = line.replace("LOCATION:", "").trim(); continue; }

    const sectionHeaders = ["SUMMARY:", "SKILLS:", "EXPERIENCE:", "EDUCATION:", "CERTIFICATIONS:"];
    if (sectionHeaders.includes(line)) {
      currentSection = line.replace(":", "");
      data.sections[currentSection] = [];
      continue;
    }
    if (currentSection && data.sections[currentSection]) {
      data.sections[currentSection].push(line);
    }
  }
  return data;
}

function generatePDF(resumeContent, templateName) {
  return new Promise((resolve, reject) => {
    const filePath = tempFilePath(".pdf");
    const doc = new PDFDocument({ margin: 0, size: "A4" });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const data = parseResumeContent(resumeContent);
    const W = 595.28; // A4 width
    const H = 841.89; // A4 height

    // ======== TEMPLATE DEFINITIONS ========
    if (templateName === "professional") {
      renderProfessionalTemplate(doc, data, W, H);
    } else if (templateName === "modern") {
      renderModernTemplate(doc, data, W, H);
    } else {
      renderMinimalTemplate(doc, data, W, H);
    }

    doc.end();
    stream.on("finish", () => { console.log(`✅ Premium PDF: ${filePath}`); resolve(filePath); });
    stream.on("error", reject);
  });
}

// ──────────────────────────────────────────────────────────────
//  TEMPLATE 1: PROFESSIONAL — Dark sidebar + clean body
// ──────────────────────────────────────────────────────────────
function renderProfessionalTemplate(doc, data, W, H) {
  const SIDEBAR_W = 200;
  const SIDEBAR_COLOR = "#1B2838";
  const ACCENT = "#4FC3F7";
  const BODY_X = SIDEBAR_W + 30;
  const BODY_W = W - BODY_X - 40;

  // ── Sidebar background ──
  doc.rect(0, 0, SIDEBAR_W, H).fill(SIDEBAR_COLOR);

  // ── Sidebar: Name & Title ──
  let sy = 45;
  doc.fontSize(20).fillColor("#FFFFFF").font("Helvetica-Bold").text(data.fullName, 20, sy, { width: SIDEBAR_W - 40 });
  sy = doc.y + 6;
  if (data.title) {
    doc.fontSize(10).fillColor(ACCENT).font("Helvetica").text(data.title.toUpperCase(), 20, sy, { width: SIDEBAR_W - 40 });
    sy = doc.y + 4;
  }

  // Accent line
  sy += 8;
  doc.moveTo(20, sy).lineTo(SIDEBAR_W - 20, sy).strokeColor(ACCENT).lineWidth(2).stroke();
  sy += 18;

  // ── Sidebar: Contact ──
  doc.fontSize(9).fillColor(ACCENT).font("Helvetica-Bold").text("CONTACT", 20, sy, { width: SIDEBAR_W - 40 });
  sy = doc.y + 8;
  doc.fontSize(8.5).fillColor("#CFD8DC").font("Helvetica");
  const contacts = [
    data.email && data.email !== "N/A" ? `✉  ${data.email}` : null,
    data.phone && data.phone !== "N/A" ? `📞  ${data.phone}` : null,
    data.location && data.location !== "N/A" ? `📍  ${data.location}` : null,
    data.linkedin && data.linkedin !== "N/A" ? `🔗  ${data.linkedin}` : null,
  ].filter(Boolean);
  for (const c of contacts) {
    doc.text(c, 20, sy, { width: SIDEBAR_W - 40 });
    sy = doc.y + 5;
  }

  // ── Sidebar: Skills ──
  if (data.sections.SKILLS && data.sections.SKILLS.length > 0) {
    sy += 15;
    doc.fontSize(9).fillColor(ACCENT).font("Helvetica-Bold").text("SKILLS", 20, sy, { width: SIDEBAR_W - 40 });
    sy = doc.y + 8;
    const skills = data.sections.SKILLS.join(", ").split(",").map((s) => s.trim()).filter(Boolean);
    doc.fontSize(8).fillColor("#CFD8DC").font("Helvetica");
    for (const skill of skills) {
      if (sy > H - 60) break;
      // Skill pill style
      doc.roundedRect(20, sy, SIDEBAR_W - 40, 16, 3).fill("#263043");
      doc.fillColor("#E0E0E0").text(skill, 28, sy + 3, { width: SIDEBAR_W - 56 });
      sy += 22;
    }
  }

  // ── Sidebar: Education ──
  if (data.sections.EDUCATION && data.sections.EDUCATION.length > 0) {
    sy += 15;
    if (sy < H - 100) {
      doc.fontSize(9).fillColor(ACCENT).font("Helvetica-Bold").text("EDUCATION", 20, sy, { width: SIDEBAR_W - 40 });
      sy = doc.y + 8;
      doc.fontSize(8).fillColor("#CFD8DC").font("Helvetica");
      for (const line of data.sections.EDUCATION) {
        if (sy > H - 40) break;
        doc.text(line, 20, sy, { width: SIDEBAR_W - 40 });
        sy = doc.y + 5;
      }
    }
  }

  // ── Sidebar: Certifications ──
  if (data.sections.CERTIFICATIONS && data.sections.CERTIFICATIONS.length > 0) {
    const certsText = data.sections.CERTIFICATIONS.join(", ");
    if (certsText !== "N/A") {
      sy += 15;
      if (sy < H - 80) {
        doc.fontSize(9).fillColor(ACCENT).font("Helvetica-Bold").text("CERTIFICATIONS", 20, sy, { width: SIDEBAR_W - 40 });
        sy = doc.y + 8;
        doc.fontSize(8).fillColor("#CFD8DC").font("Helvetica");
        for (const line of data.sections.CERTIFICATIONS) {
          if (sy > H - 30) break;
          doc.text(`▸ ${line}`, 20, sy, { width: SIDEBAR_W - 40 });
          sy = doc.y + 4;
        }
      }
    }
  }

  // ── Body: Summary ──
  let by = 50;
  if (data.sections.SUMMARY && data.sections.SUMMARY.length > 0) {
    doc.fontSize(12).fillColor(SIDEBAR_COLOR).font("Helvetica-Bold").text("PROFESSIONAL SUMMARY", BODY_X, by, { width: BODY_W });
    by = doc.y + 4;
    doc.moveTo(BODY_X, by).lineTo(BODY_X + 60, by).strokeColor(ACCENT).lineWidth(2.5).stroke();
    by += 10;
    doc.fontSize(9.5).fillColor("#444444").font("Helvetica").text(data.sections.SUMMARY.join(" "), BODY_X, by, { width: BODY_W, lineGap: 3 });
    by = doc.y + 20;
  }

  // ── Body: Experience ──
  if (data.sections.EXPERIENCE && data.sections.EXPERIENCE.length > 0) {
    doc.fontSize(12).fillColor(SIDEBAR_COLOR).font("Helvetica-Bold").text("WORK EXPERIENCE", BODY_X, by, { width: BODY_W });
    by = doc.y + 4;
    doc.moveTo(BODY_X, by).lineTo(BODY_X + 60, by).strokeColor(ACCENT).lineWidth(2.5).stroke();
    by += 12;

    for (const line of data.sections.EXPERIENCE) {
      if (by > H - 50) { doc.addPage(); by = 50; doc.rect(0, 0, SIDEBAR_W, H).fill(SIDEBAR_COLOR); }

      if (line.includes(" | ")) {
        by += 4;
        const parts = line.split("|").map((p) => p.trim());
        doc.fontSize(10.5).fillColor("#1B2838").font("Helvetica-Bold").text(parts[1] || parts[0], BODY_X, by, { width: BODY_W, continued: false });
        by = doc.y + 1;
        const subtitle = [parts[0], parts[2]].filter(Boolean).join("  •  ");
        doc.fontSize(8.5).fillColor(ACCENT).font("Helvetica").text(subtitle, BODY_X, by, { width: BODY_W });
        by = doc.y + 5;
      } else if (line.startsWith("-") || line.startsWith("•")) {
        const bullet = line.replace(/^[-•]\s*/, "");
        doc.fontSize(9).fillColor("#555555").font("Helvetica").text(`▸  ${bullet}`, BODY_X + 8, by, { width: BODY_W - 8, lineGap: 2 });
        by = doc.y + 4;
      } else {
        doc.fontSize(9).fillColor("#555555").font("Helvetica").text(line, BODY_X, by, { width: BODY_W, lineGap: 2 });
        by = doc.y + 4;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
//  TEMPLATE 2: MODERN — Colored header band + two-column body
// ──────────────────────────────────────────────────────────────
function renderModernTemplate(doc, data, W, H) {
  const HEADER_H = 120;
  const GRAD_TOP = "#0F2027";
  const GRAD_BOT = "#2C5364";
  const ACCENT = "#00BFA5";
  const MX = 45;
  const CONTENT_W = W - MX * 2;

  // ── Header gradient band ──
  const steps = 30;
  for (let i = 0; i < steps; i++) {
    const ratio = i / steps;
    const r = Math.round(15 + ratio * (44 - 15));
    const g = Math.round(32 + ratio * (83 - 32));
    const b = Math.round(39 + ratio * (100 - 39));
    const color = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    doc.rect(0, (HEADER_H / steps) * i, W, HEADER_H / steps + 1).fill(color);
  }

  // ── Header text ──
  doc.fontSize(26).fillColor("#FFFFFF").font("Helvetica-Bold").text(data.fullName, MX, 30, { width: CONTENT_W });
  if (data.title) {
    doc.fontSize(11).fillColor(ACCENT).font("Helvetica").text(data.title.toUpperCase(), MX, doc.y + 4, { width: CONTENT_W, characterSpacing: 1.5 });
  }
  const contacts = [
    data.email !== "N/A" ? data.email : null,
    data.phone !== "N/A" ? data.phone : null,
    data.location !== "N/A" ? data.location : null,
  ].filter(Boolean);
  if (contacts.length) {
    doc.fontSize(8.5).fillColor("#B0BEC5").text(contacts.join("   |   "), MX, doc.y + 6, { width: CONTENT_W });
  }

  let y = HEADER_H + 25;

  function sectionHeader(title) {
    doc.fontSize(11).fillColor(GRAD_BOT).font("Helvetica-Bold").text(title, MX, y, { width: CONTENT_W });
    y = doc.y + 3;
    doc.moveTo(MX, y).lineTo(MX + 45, y).strokeColor(ACCENT).lineWidth(2.5).stroke();
    doc.moveTo(MX + 47, y).lineTo(W - MX, y).strokeColor("#E0E0E0").lineWidth(0.5).stroke();
    y += 10;
  }

  // ── Summary ──
  if (data.sections.SUMMARY?.length) {
    sectionHeader("SUMMARY");
    doc.fontSize(9.5).fillColor("#444").font("Helvetica").text(data.sections.SUMMARY.join(" "), MX, y, { width: CONTENT_W, lineGap: 3 });
    y = doc.y + 18;
  }

  // ── Skills (pills layout) ──
  if (data.sections.SKILLS?.length) {
    sectionHeader("SKILLS");
    const skills = data.sections.SKILLS.join(", ").split(",").map((s) => s.trim()).filter(Boolean);
    let sx = MX;
    for (const skill of skills) {
      const tw = doc.widthOfString(skill, { fontSize: 8 }) + 18;
      if (sx + tw > W - MX) { sx = MX; y += 22; }
      if (y > H - 50) { doc.addPage(); y = 40; }
      doc.roundedRect(sx, y, tw, 17, 8).fill("#E8F5E9");
      doc.fontSize(8).fillColor("#2E7D32").font("Helvetica").text(skill, sx + 9, y + 4);
      sx += tw + 6;
    }
    y += 30;
  }

  // ── Experience ──
  if (data.sections.EXPERIENCE?.length) {
    sectionHeader("EXPERIENCE");
    for (const line of data.sections.EXPERIENCE) {
      if (y > H - 50) { doc.addPage(); y = 40; }
      if (line.includes(" | ")) {
        const parts = line.split("|").map((p) => p.trim());
        doc.fontSize(10).fillColor("#1a1a2e").font("Helvetica-Bold").text(parts[1] || parts[0], MX, y, { width: CONTENT_W });
        y = doc.y + 1;
        doc.fontSize(8.5).fillColor(ACCENT).font("Helvetica").text([parts[0], parts[2]].filter(Boolean).join("  •  "), MX, y, { width: CONTENT_W });
        y = doc.y + 5;
      } else if (line.startsWith("-") || line.startsWith("•")) {
        doc.fontSize(9).fillColor("#555").font("Helvetica").text(`▸  ${line.replace(/^[-•]\s*/, "")}`, MX + 10, y, { width: CONTENT_W - 10, lineGap: 2 });
        y = doc.y + 4;
      }
    }
    y += 12;
  }

  // ── Education ──
  if (data.sections.EDUCATION?.length) {
    if (y > H - 80) { doc.addPage(); y = 40; }
    sectionHeader("EDUCATION");
    doc.fontSize(9.5).fillColor("#333").font("Helvetica");
    for (const line of data.sections.EDUCATION) {
      doc.text(line, MX, y, { width: CONTENT_W });
      y = doc.y + 5;
    }
    y += 10;
  }

  // ── Certifications ──
  if (data.sections.CERTIFICATIONS?.length) {
    const certsText = data.sections.CERTIFICATIONS.join(", ");
    if (certsText !== "N/A") {
      if (y > H - 60) { doc.addPage(); y = 40; }
      sectionHeader("CERTIFICATIONS");
      doc.fontSize(9).fillColor("#555").font("Helvetica");
      for (const c of data.sections.CERTIFICATIONS) {
        doc.text(`▸  ${c}`, MX, y, { width: CONTENT_W });
        y = doc.y + 4;
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────
//  TEMPLATE 3: MINIMAL — Clean, ATS-optimized, maximum readability
// ──────────────────────────────────────────────────────────────
function renderMinimalTemplate(doc, data, W, H) {
  const MX = 50;
  const CONTENT_W = W - MX * 2;
  const DARK = "#222222";
  const MID = "#555555";
  const ACCENT = "#333333";

  // ── Name ──
  let y = 45;
  doc.fontSize(22).fillColor(DARK).font("Helvetica-Bold").text(data.fullName.toUpperCase(), MX, y, { width: CONTENT_W, align: "center", characterSpacing: 2 });
  y = doc.y + 4;
  if (data.title) {
    doc.fontSize(10).fillColor(MID).font("Helvetica").text(data.title, MX, y, { width: CONTENT_W, align: "center" });
    y = doc.y + 3;
  }

  // Contact line
  const contacts = [
    data.email !== "N/A" ? data.email : null,
    data.phone !== "N/A" ? data.phone : null,
    data.location !== "N/A" ? data.location : null,
    data.linkedin !== "N/A" ? data.linkedin : null,
  ].filter(Boolean);
  if (contacts.length) {
    doc.fontSize(8.5).fillColor("#777").text(contacts.join("   •   "), MX, y + 3, { width: CONTENT_W, align: "center" });
    y = doc.y + 5;
  }

  // Top rule
  y += 6;
  doc.moveTo(MX, y).lineTo(W - MX, y).strokeColor(DARK).lineWidth(1.5).stroke();
  y += 15;

  function sectionHead(title) {
    if (y > H - 60) { doc.addPage(); y = 45; }
    doc.fontSize(10).fillColor(DARK).font("Helvetica-Bold").text(title.toUpperCase(), MX, y, { width: CONTENT_W, characterSpacing: 1.5 });
    y = doc.y + 3;
    doc.moveTo(MX, y).lineTo(W - MX, y).strokeColor("#CCCCCC").lineWidth(0.5).stroke();
    y += 8;
  }

  // ── Summary ──
  if (data.sections.SUMMARY?.length) {
    sectionHead("Professional Summary");
    doc.fontSize(9.5).fillColor(MID).font("Helvetica").text(data.sections.SUMMARY.join(" "), MX, y, { width: CONTENT_W, lineGap: 3 });
    y = doc.y + 15;
  }

  // ── Skills ──
  if (data.sections.SKILLS?.length) {
    sectionHead("Core Competencies");
    doc.fontSize(9).fillColor(ACCENT).font("Helvetica").text(data.sections.SKILLS.join(", "), MX, y, { width: CONTENT_W, lineGap: 2 });
    y = doc.y + 15;
  }

  // ── Experience ──
  if (data.sections.EXPERIENCE?.length) {
    sectionHead("Professional Experience");
    for (const line of data.sections.EXPERIENCE) {
      if (y > H - 50) { doc.addPage(); y = 45; }
      if (line.includes(" | ")) {
        const parts = line.split("|").map((p) => p.trim());
        doc.fontSize(10).fillColor(DARK).font("Helvetica-Bold").text(parts[1] || parts[0], MX, y, { width: CONTENT_W * 0.65, continued: false });
        // Date on right
        if (parts[2]) {
          doc.fontSize(8.5).fillColor("#999").font("Helvetica").text(parts[2], MX, doc.y - 12, { width: CONTENT_W, align: "right" });
        }
        y = doc.y + 1;
        if (parts[0]) {
          doc.fontSize(9).fillColor(MID).font("Helvetica").text(parts[0], MX, y, { width: CONTENT_W });
          y = doc.y + 4;
        }
      } else if (line.startsWith("-") || line.startsWith("•")) {
        doc.fontSize(9).fillColor(MID).font("Helvetica").text(`•  ${line.replace(/^[-•]\s*/, "")}`, MX + 10, y, { width: CONTENT_W - 10, lineGap: 2 });
        y = doc.y + 3;
      }
    }
    y += 12;
  }

  // ── Education ──
  if (data.sections.EDUCATION?.length) {
    sectionHead("Education");
    doc.fontSize(9.5).fillColor(MID).font("Helvetica");
    for (const line of data.sections.EDUCATION) {
      doc.text(line, MX, y, { width: CONTENT_W });
      y = doc.y + 5;
    }
    y += 10;
  }

  // ── Certifications ──
  if (data.sections.CERTIFICATIONS?.length) {
    const certsText = data.sections.CERTIFICATIONS.join(", ");
    if (certsText !== "N/A") {
      sectionHead("Certifications");
      doc.fontSize(9).fillColor(MID).font("Helvetica");
      for (const c of data.sections.CERTIFICATIONS) {
        if (y > H - 40) { doc.addPage(); y = 45; }
        doc.text(`•  ${c}`, MX, y, { width: CONTENT_W });
        y = doc.y + 4;
      }
    }
  }
}

// ============================================================
//  CORE PIPELINE
// ============================================================
async function processResume(chatId, fileId, fileName) {
  let tempPath = null;
  const session = getSession(chatId);

  try {
    await bot.sendMessage(chatId, "⏳ Parsing your resume...");

    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const buffer = await downloadFile(fileUrl);

    if (!buffer || buffer.length === 0) {
      await bot.sendMessage(chatId, "❌ File appears empty.");
      session.state = "WAITING_RESUME";
      return;
    }

    let text = "";
    const ext = path.extname(fileName).toLowerCase();

    if (ext === ".pdf") {
      text = await extractPDF(buffer);
    } else if ([".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"].includes(ext)) {
      tempPath = tempFilePath(ext);
      fs.writeFileSync(tempPath, buffer);
      text = await extractImage(tempPath);
    } else {
      await bot.sendMessage(chatId, `❌ Unsupported format: *${ext}*\nSend a PDF or image.`, { parse_mode: "Markdown" });
      session.state = "WAITING_RESUME";
      return;
    }

    if (!text || text.length < 20) {
      await bot.sendMessage(chatId, "❌ Could not extract text. Make sure file isn't blank.");
      session.state = "WAITING_RESUME";
      return;
    }

    session.resumeText = text;
    await bot.sendMessage(chatId, "🤖 Analyzing your resume against the job description...");
    const result = await analyzeResume(text, session.jobDescription);
    session.aiResult = result;
    await sendLong(chatId, result);

    session.state = "WAITING_TEMPLATE";
    await bot.sendMessage(chatId, "📄 *Choose a resume template to generate your improved PDF:*", {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📋 Professional", callback_data: "template_professional" },
            { text: "🎨 Modern", callback_data: "template_modern" },
          ],
          [{ text: "📄 Minimal (ATS-Safe)", callback_data: "template_minimal" }],
        ],
      },
    });
    console.log(`✅ ATS sent, awaiting template (chat ${chatId})`);
  } catch (err) {
    console.error("❌ Error:", err.message || err);
    let msg = "❌ Something went wrong. Please try again.";
    if (err.response?.status === 401) msg = "❌ API auth failed. Contact admin.";
    else if (err.response?.status === 429) msg = "❌ Rate limit. Wait a minute.";
    else if (err.code === "ECONNABORTED") msg = "❌ Timed out. Try again.";
    try { await bot.sendMessage(chatId, msg); } catch (_) {}
    resetSession(chatId);
  } finally {
    if (tempPath && fs.existsSync(tempPath)) { try { fs.unlinkSync(tempPath); } catch (_) {} }
  }
}

// ============================================================
//  EVENT HANDLERS
// ============================================================

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  getSession(chatId).state = "WAITING_JD";
  bot.sendMessage(chatId,
    `🎯 *ATS Resume Analyzer Bot*\n\n` +
    `I'll optimize your resume for a specific job!\n\n` +
    `*How it works:*\n` +
    `1️⃣ Paste the *Job Description*\n` +
    `2️⃣ Upload your *Resume* (PDF or image)\n` +
    `3️⃣ Get AI-powered ATS analysis\n` +
    `4️⃣ Pick a premium template\n` +
    `5️⃣ Receive your *improved PDF*!\n\n` +
    `👇 *Paste the Job Description below:*`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/reset/, (msg) => {
  resetSession(msg.chat.id);
  bot.sendMessage(msg.chat.id, "🔄 Reset. Type /start to begin again.");
});

bot.on("text", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  if (text.startsWith("/")) return;

  const session = getSession(chatId);

  if (session.state === "IDLE") {
    bot.sendMessage(chatId, "👋 Type /start to begin!");
    return;
  }
  if (session.state === "WAITING_JD") {
    if (text.length < 20) {
      bot.sendMessage(chatId, "⚠️ That's too short. Paste the full Job Description.");
      return;
    }
    session.jobDescription = text;
    session.state = "WAITING_RESUME";
    console.log(`📋 JD received (chat ${chatId}, ${text.length} chars)`);
    bot.sendMessage(chatId, `✅ *Job Description saved!*\n\n📎 Now send your *resume* as a PDF or image.`, { parse_mode: "Markdown" });
    return;
  }
  if (session.state === "WAITING_RESUME") {
    bot.sendMessage(chatId, "📎 Send your resume as a *file*, not text.", { parse_mode: "Markdown" });
    return;
  }
  if (session.state === "WAITING_TEMPLATE") {
    bot.sendMessage(chatId, "👆 Click one of the template buttons above.");
    return;
  }
});

bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (session.state !== "WAITING_RESUME") {
    bot.sendMessage(chatId, "⚠️ Send the *Job Description* first! Type /start", { parse_mode: "Markdown" });
    return;
  }
  const d = msg.document;
  console.log(`\n📨 Doc: ${d.file_name} (${d.file_size}B) chat ${chatId}`);
  await processResume(chatId, d.file_id, d.file_name || "resume.pdf");
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (session.state !== "WAITING_RESUME") {
    bot.sendMessage(chatId, "⚠️ Send the *Job Description* first! Type /start", { parse_mode: "Markdown" });
    return;
  }
  const photo = msg.photo[msg.photo.length - 1];
  console.log(`\n📸 Photo (${photo.file_size}B) chat ${chatId}`);
  await processResume(chatId, photo.file_id, `photo_${chatId}.jpg`);
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const session = getSession(chatId);
  await bot.answerCallbackQuery(query.id);

  if (session.state !== "WAITING_TEMPLATE" || !session.resumeText || !session.jobDescription) {
    await bot.sendMessage(chatId, "⚠️ Session expired. Type /start");
    resetSession(chatId);
    return;
  }

  const tMap = { template_professional: "professional", template_modern: "modern", template_minimal: "minimal" };
  const tName = tMap[query.data];
  if (!tName) return;

  let pdfPath = null;
  try {
    await bot.sendMessage(chatId, `⏳ Generating your *${tName}* resume...`, { parse_mode: "Markdown" });
    const improved = await generateImprovedResume(session.resumeText, session.jobDescription);
    pdfPath = await generatePDF(improved, tName);
    await bot.sendDocument(chatId, pdfPath, {
      caption: `✅ Your *${tName}* resume is ready!\n\nType /start to analyze another.`,
      parse_mode: "Markdown",
    });
    console.log(`✅ PDF sent (chat ${chatId})`);
    resetSession(chatId);
  } catch (err) {
    console.error("❌ PDF error:", err.message || err);
    try { await bot.sendMessage(chatId, "❌ Failed. Try again.\n/start"); } catch (_) {}
    resetSession(chatId);
  } finally {
    if (pdfPath && fs.existsSync(pdfPath)) { try { fs.unlinkSync(pdfPath); } catch (_) {} }
  }
});

// ============================================================
//  GLOBAL ERROR HANDLERS
// ============================================================
bot.on("polling_error", (err) => console.error("🔴 Polling:", err.message));
process.on("unhandledRejection", (r) => console.error("🔴 Unhandled:", r));
process.on("uncaughtException", (e) => console.error("🔴 Uncaught:", e));