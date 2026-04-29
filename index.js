require("dotenv").config();

// ── Validate required env vars immediately ─────────────────────────────────
["BOT_TOKEN", "GROQ_API_KEY"].forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}. Exiting.`);
    process.exit(1);
  }
});

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const logger = require("./src/logger");
const db = require("./src/db");
const { handleMessage } = require("./src/stateMachine");
const { checkRateLimit } = require("./src/rateLimiter");
const { generatePDF } = require("./src/pdfGenerator");
const { startCleanupScheduler } = require("./src/cleanup");

// ─── Bot init ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ═══════════════════════════════════════════════════════════════════════
//  DUMMY HTTP SERVER (For Render Health Checks)
// ═══════════════════════════════════════════════════════════════════════
const http = require("http");
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running...\n");
}).listen(PORT, () => {
  logger.info(`Health check server listening on port ${PORT}`);
});

async function init() {
  await db.initDB();
  startCleanupScheduler();
  logger.info("✅ Bot is running...");
}

init();

// ═══════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER (State Machine Router)
// ═══════════════════════════════════════════════════════════════════════

bot.on("text", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  // Rate limit check
  const rl = checkRateLimit(chatId);
  if (!rl.allowed) {
    const secs = Math.ceil(rl.remainingMs / 1000);
    await bot.sendMessage(chatId, `⏱ Please wait ${secs}s before sending another message.`);
    return;
  }

  await handleMessage(chatId, msg.from.username, msg.from.first_name, text, bot);
});

// For document/photo, we'd normally parse it. We can add a simple handler that tells them we don't support file upload right now, 
// OR we extract text using the existing extractor and pass the text to handleMessage.
// Since we want to integrate it natively:
const { extractPDF, extractImage } = require("./src/extractor");
const { validateFile } = require("./src/validator");
const { MAX_FILE_BYTES } = require("./src/config");
const axios = require("axios");

async function safeDownload(fileUrl) {
  const r = await axios.get(fileUrl, { responseType: "arraybuffer", timeout: 30000 });
  return Buffer.from(r.data);
}

async function processFile(msg, fileId, fileName, fileSize) {
  const chatId = msg.chat.id;
  
  if (fileSize > MAX_FILE_BYTES) {
    await bot.sendMessage(chatId, `❌ File too large. Max allowed: 5 MB.`);
    return;
  }

  try {
    await bot.sendMessage(chatId, "📄 Reading your file...");
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    const buffer = await safeDownload(fileUrl);
    
    const fv = validateFile(buffer, fileName, buffer.length);
    if (!fv.valid) {
      await bot.sendMessage(chatId, `❌ ${fv.errors.join("\n")}`, { parse_mode: "Markdown" });
      return;
    }

    const ext = path.extname(fileName || "").toLowerCase();
    let extractedText = "";

    if (ext === ".pdf") {
      const { text } = await extractPDF(buffer);
      extractedText = text;
    } else {
      const ocrResult = await extractImage(buffer);
      if (ocrResult.rejected) {
        await bot.sendMessage(chatId, `❌ OCR Failed: ${ocrResult.reason}`);
        return;
      }
      extractedText = ocrResult.text;
    }

    if (!extractedText || extractedText.length < 50) {
      await bot.sendMessage(chatId, "❌ Could not extract readable text from this file.");
      return;
    }

    // Treat the extracted text as a massive user message providing info
    await handleMessage(chatId, msg.from.username, msg.from.first_name, `[FILE UPLOAD CONTENT]\n${extractedText}`, bot);

  } catch (err) {
    logger.error("File processing error", { error: err.message });
    await bot.sendMessage(chatId, "❌ Something went wrong reading your file.");
  }
}

bot.on("document", async (msg) => {
  const d = msg.document;
  await processFile(msg, d.file_id, d.file_name || "resume.pdf", d.file_size);
});

bot.on("photo", async (msg) => {
  const photo = msg.photo[msg.photo.length - 1];
  await processFile(msg, photo.file_id, `photo_${msg.chat.id}.jpg`, photo.file_size);
});

// ═══════════════════════════════════════════════════════════════════════
//  CALLBACK QUERY (template selection)
// ═══════════════════════════════════════════════════════════════════════

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id);

  // 1. Handle quick actions (Allowed in any state)
  if (query.data.startsWith("action_")) {
    const action = query.data.replace("action_", "");
    switch (action) {
      case "start":
        await bot.sendMessage(chatId, "Great! Let's start with your *target job role*. What position are you aiming for?", { parse_mode: "Markdown" });
        break;
      case "improve":
        await bot.sendMessage(chatId, "Please paste your *current resume text* here or *upload the PDF/Image* file, and I'll upgrade it for you!", { parse_mode: "Markdown" });
        break;
      case "help":
        await handleMessage(chatId, query.from.username, query.from.first_name, "/help", bot);
        break;
    }
    return;
  }

  // 2. Handle template selection (Requires WAITING_TEMPLATE state)
  const session = await db.getSession(chatId);
  if (!session || session.current_state !== "WAITING_TEMPLATE") {
    await bot.sendMessage(chatId, "⚠️ Invalid state or session expired. Say 'generate' to trigger this again.");
    return;
  }

  if (session.processing) {
    await bot.sendMessage(chatId, "⏳ Already generating. Please wait...");
    return;
  }

  const tMap = {
    template_professional: "professional",
    template_modern:       "modern",
    template_minimal:      "minimal",
  };

  // Handle template selection
  if (tMap[query.data]) {
    const tName = tMap[query.data];

    // Check daily generation limit
    try {
      const limitInfo = await db.checkGenerationLimit(chatId, 6);
      if (!limitInfo.allowed) {
        await bot.sendMessage(chatId, "⚠️ *Daily Limit Reached*\n\nYou've reached your limit of 6 resumes per 24 hours. Please come back tomorrow or contact support for higher limits!", { parse_mode: "Markdown" });
        return;
      }
    } catch (err) {
      logger.error("Limit check failed", { chatId, error: err.message });
      // Proceed anyway to not block users on DB glitches
    }

    await db.updateSessionState(chatId, "GENERATING", { processing: true });

    let pdfPath = null;
    try {
      const profile = await db.getProfile(chatId);
      if (!profile) throw new Error("No profile found");

      await bot.sendMessage(chatId, `⏳ Generating your *${tName}* resume PDF...`, { parse_mode: "Markdown" });

      pdfPath = await generatePDF(profile, tName);

      await bot.sendDocument(chatId, pdfPath, {
        caption: `✅ Your *${tName}* resume is ready!\n\nIf you want to edit anything, just tell me!`,
        parse_mode: "Markdown",
      });

      // Record the generation in DB
      await db.recordGeneration(chatId, pdfPath, tName);

      logger.info("PDF delivered", { chatId, template: tName });
      await db.updateSessionState(chatId, "COMPLETED", { processing: false });

    } catch (err) {
      logger.error("PDF generation error", { chatId, error: err.message });
      await bot.sendMessage(chatId, "❌ Failed to generate resume. Please try again.");
      await db.updateSessionState(chatId, "WAITING_TEMPLATE", { processing: false });
    } finally {
      if (pdfPath && fs.existsSync(pdfPath)) {
        try { fs.unlinkSync(pdfPath); } catch (_) {}
      }
      // Make sure processing lock is removed if it wasn't caught
      const checkSession = await db.getSession(chatId);
      if (checkSession && checkSession.processing) {
        await db.updateSessionState(chatId, checkSession.current_state, { processing: false });
      }
    }
    return;
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  GLOBAL ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════════════

bot.on("polling_error", (err) => logger.error("Polling error", { error: err.message }));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: String(reason) });
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception — shutting down", { error: err.message, stack: err.stack });
  process.exit(1); 
});