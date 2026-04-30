const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
require("pdf-parse/worker"); // Required for v2+ to avoid DOMMatrix/Worker errors during startup
const { PDFParse } = require("pdf-parse");
const Tesseract = require("tesseract.js");
const logger = require("./logger");
const { OCR_CONFIDENCE_MIN, IMAGE_EXTENSIONS } = require("./config");
const { detectMime } = require("./validator");

function tempFilePath(ext) {
  return path.join(os.tmpdir(), `resume_${crypto.randomUUID()}${ext}`);
}

// ─── PDF extraction ─────────────────────────────────────────────────────────
async function extractPDF(buffer) {
  logger.info("Extracting PDF text...");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = (result.text || "").trim();
    logger.info("PDF extraction complete", { chars: text.length });
    return { text, pages: result.numpages || null };
  } finally {
    try { await parser.destroy(); } catch (_) {}
  }
}

// ─── Image OCR ─────────────────────────────────────────────────────────────
async function extractImage(buffer) {
  // Detect the real image extension from magic bytes
  const mime = detectMime(buffer);
  const mimeToExt = {
    "image/jpeg": ".jpg",
    "image/png":  ".png",
    "image/webp": ".webp",
    "image/tiff": ".tiff",
    "image/bmp":  ".bmp",
  };
  const ext = mimeToExt[mime] || ".jpg";
  const tempPath = tempFilePath(ext);

  try {
    fs.writeFileSync(tempPath, buffer);
    logger.info("Running OCR...", { ext, bytes: buffer.length });

    const result = await Tesseract.recognize(tempPath, "eng");
    const text = (result.data.text || "").trim();
    const confidence = result.data.confidence || 0;

    logger.info("OCR complete", { chars: text.length, confidence });

    if (confidence < OCR_CONFIDENCE_MIN) {
      return {
        text,
        confidence,
        rejected: true,
        reason: `OCR confidence too low (${confidence.toFixed(0)}%). Please upload a clearer, higher-resolution image.`,
      };
    }

    return { text, confidence, rejected: false };
  } finally {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
  }
}

module.exports = { extractPDF, extractImage, tempFilePath };
