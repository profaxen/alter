const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const logger = require("./logger");

function tempFilePath(ext) {
  return path.join(os.tmpdir(), `resume_${crypto.randomUUID()}${ext}`);
}

function safeParseArray(data) {
  if (Array.isArray(data)) return data;
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return [];
}

function normalizeData(profile) {
  const skillsArr = safeParseArray(profile.skills);
  const expArr = safeParseArray(profile.experience);
  const eduArr = safeParseArray(profile.education);
  const projArr = safeParseArray(profile.projects);
  const certArr = safeParseArray(profile.certifications);
  const langArr = safeParseArray(profile.languages);

  const links = profile.links || {};

  return {
    fullName: profile.full_name || "Candidate",
    title: profile.experience?.[0]?.title || "",
    email: profile.email || "N/A",
    phone: profile.phone || "N/A",
    linkedin: links.linkedin || "N/A",
    github: links.github || "N/A",
    portfolio: links.portfolio || "N/A",
    location: profile.location || "N/A",
    sections: {
      SUMMARY: profile.summary ? [profile.summary] : [],
      SKILLS: skillsArr,
      EXPERIENCE: expArr.map(exp => {
        const company = exp.company || exp.organization || 'Company';
        const title = exp.title || exp.role || 'Professional Role';
        let titleLine = `${company} | ${title}`;
        if (exp.dates) titleLine += ` | ${exp.dates}`;
        
        const bullets = Array.isArray(exp.bullets) ? exp.bullets.map(b => `- ${b}`) : [];
        return [titleLine, ...bullets].join('\n');
      }).flatMap(x => x.split('\n')),
      PROJECTS: projArr.map(proj => {
        const name = proj.name || proj.title || 'Project';
        let line = `${name}`;
        if (proj.technologies?.length) line += ` | ${proj.technologies.join(', ')}`;
        const desc = Array.isArray(proj.description) ? proj.description.map(d => `- ${d}`) : (proj.description ? [`- ${proj.description}`] : []);
        const link = proj.link ? [`- Link: ${proj.link}`] : [];
        return [line, ...desc, ...link].join('\n');
      }).flatMap(x => x.split('\n')),
      EDUCATION: eduArr.map(ed => 
        `${ed.degree || 'Degree'} | ${ed.school || 'School'} | ${ed.year || ''}`
      ),
      CERTIFICATIONS: certArr,
      LANGUAGES: langArr
    }
  };
}

// ─── PDF wrapper ────────────────────────────────────────────────────────────
function generatePDF(profileJSON, templateName) {
  return new Promise((resolve, reject) => {
    const filePath = tempFilePath(".pdf");
    const doc = new PDFDocument({ margin: 0, size: "A4" });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const data = normalizeData(profileJSON);
    const W = 595.28;
    const H = 841.89;

    try {
      if (templateName === "professional") renderProfessional(doc, data, W, H);
      else if (templateName === "modern")  renderModern(doc, data, W, H);
      else                                 renderMinimal(doc, data, W, H);
    } catch (err) {
      doc.end();
      return reject(err);
    }

    doc.end();
    stream.on("finish", () => { logger.info("PDF generated", { filePath, template: templateName }); resolve(filePath); });
    stream.on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  TEMPLATE 1 — PROFESSIONAL (dark sidebar)
// ═══════════════════════════════════════════════════════════════════════
function renderProfessional(doc, data, W, H) {
  const SW = 200, SC = "#1B2838", AC = "#4FC3F7", BX = 230, BW = W - BX - 40;

  doc.rect(0, 0, SW, H).fill(SC);

  let sy = 45;
  doc.fontSize(20).fillColor("#FFF").font("Helvetica-Bold")
     .text(data.fullName, 20, sy, { width: SW - 40 });
  sy = doc.y + 6;
  if (data.title) {
    doc.fontSize(10).fillColor(AC).font("Helvetica")
       .text(data.title.toUpperCase(), 20, sy, { width: SW - 40 });
    sy = doc.y + 4;
  }
  sy += 8;
  doc.moveTo(20, sy).lineTo(SW - 20, sy).strokeColor(AC).lineWidth(2).stroke();
  sy += 18;

  // Contact
  doc.fontSize(9).fillColor(AC).font("Helvetica-Bold").text("CONTACT", 20, sy, { width: SW - 40 });
  sy = doc.y + 8;
  doc.fontSize(8.5).fillColor("#CFD8DC").font("Helvetica");
  const contacts = [
    data.email !== "N/A" ? `Email: ${data.email}` : null,
    data.phone !== "N/A" ? `Phone: ${data.phone}` : null,
    data.location !== "N/A" ? `Loc: ${data.location}` : null,
    data.linkedin !== "N/A" ? `LinkedIn` : null,
    data.github !== "N/A" ? `GitHub` : null,
    data.portfolio !== "N/A" ? `Portfolio` : null,
  ].filter(Boolean);
  for (const c of contacts) { doc.text(c, 20, sy, { width: SW - 40 }); sy = doc.y + 5; }

  // Skills (Sidebar)
  if (data.sections.SKILLS?.length) {
    sy += 12;
    doc.fontSize(9).fillColor(AC).font("Helvetica-Bold").text("SKILLS", 20, sy, { width: SW - 40 });
    sy = doc.y + 6;
    const skillsList = Array.isArray(data.sections.SKILLS) ? data.sections.SKILLS : [data.sections.SKILLS];
    doc.fontSize(7.5).fillColor("#CFD8DC").font("Helvetica");
    for (const skill of skillsList) {
      if (sy > H - 160) break; // Leave space for Edu and Cert
      doc.roundedRect(20, sy, SW - 40, 14, 2).fill("#263043");
      doc.fillColor("#E0E0E0").text(skill, 26, sy + 3, { width: SW - 52 });
      sy += 17;
    }
  }

  // Languages (Sidebar)
  if (data.sections.LANGUAGES?.length && sy < H - 140) {
    sy += 8;
    doc.fontSize(9).fillColor(AC).font("Helvetica-Bold").text("LANGUAGES", 20, sy, { width: SW - 40 });
    sy = doc.y + 5;
    doc.fontSize(8).fillColor("#CFD8DC").font("Helvetica");
    doc.text(data.sections.LANGUAGES.join(", "), 20, sy, { width: SW - 40 });
    sy = doc.y + 8;
  }

  // Education (Sidebar)
  if (data.sections.EDUCATION?.length && sy < H - 100) {
    sy += 12;
    doc.fontSize(9).fillColor(AC).font("Helvetica-Bold").text("EDUCATION", 20, sy, { width: SW - 40 });
    sy = doc.y + 6;
    doc.fontSize(7.5).fillColor("#CFD8DC").font("Helvetica");
    for (const line of data.sections.EDUCATION) {
      if (sy > H - 60) break;
      doc.text(line, 20, sy, { width: SW - 40 }); sy = doc.y + 4;
    }
  }

  // Certifications (Sidebar)
  if (data.sections.CERTIFICATIONS?.length && sy < H - 40) {
    sy += 12;
    doc.fontSize(9).fillColor(AC).font("Helvetica-Bold").text("CERTIFICATIONS", 20, sy, { width: SW - 40 });
    sy = doc.y + 6;
    doc.fontSize(7.5).fillColor("#CFD8DC").font("Helvetica");
    for (const line of data.sections.CERTIFICATIONS) {
      if (sy > H - 25) break;
      doc.text(`• ${line}`, 20, sy, { width: SW - 40 }); sy = doc.y + 3;
    }
  }

  // Body: Summary
  let by = 50;
  if (data.sections.SUMMARY?.length) {
    doc.fontSize(12).fillColor(SC).font("Helvetica-Bold").text("PROFESSIONAL SUMMARY", BX, by, { width: BW });
    by = doc.y + 4;
    doc.moveTo(BX, by).lineTo(BX + 60, by).strokeColor(AC).lineWidth(2.5).stroke();
    by += 10;
    doc.fontSize(9.5).fillColor("#444").font("Helvetica")
       .text(data.sections.SUMMARY.join(" "), BX, by, { width: BW, lineGap: 3 });
    by = doc.y + 20;
  }

  // Body: Experience
  if (data.sections.EXPERIENCE?.length) {
    doc.fontSize(12).fillColor(SC).font("Helvetica-Bold").text("WORK EXPERIENCE", BX, by, { width: BW });
    by = doc.y + 4;
    doc.moveTo(BX, by).lineTo(BX + 60, by).strokeColor(AC).lineWidth(2.5).stroke();
    by += 12;

    for (const line of data.sections.EXPERIENCE) {
      if (by > H - 100) { doc.addPage(); by = 50; doc.rect(0, 0, SW, H).fill(SC); }
      if (line.includes(" | ")) {
        by += 4;
        const parts = line.split("|").map((p) => p.trim());
        doc.fontSize(10.5).fillColor("#1B2838").font("Helvetica-Bold")
           .text(parts[1] || parts[0], BX, by, { width: BW });
        by = doc.y + 1;
        doc.fontSize(8.5).fillColor(AC).font("Helvetica")
           .text([parts[0], parts[2]].filter(Boolean).join("  •  "), BX, by, { width: BW });
        by = doc.y + 5;
      } else if (line.startsWith("-") || line.startsWith("•")) {
        doc.fontSize(9).fillColor("#555").font("Helvetica")
           .text(`•  ${line.replace(/^[-•]\s*/, "")}`, BX + 10, by, { width: BW - 10, lineGap: 2 });
        by = doc.y + 4;
      }
    }
    by += 15;
  }

  // Body: Projects
  if (data.sections.PROJECTS?.length) {
    if (by > H - 100) { doc.addPage(); by = 50; doc.rect(0, 0, SW, H).fill(SC); }
    doc.fontSize(12).fillColor(SC).font("Helvetica-Bold").text("PROJECTS", BX, by, { width: BW });
    by = doc.y + 4;
    doc.moveTo(BX, by).lineTo(BX + 60, by).strokeColor(AC).lineWidth(2.5).stroke();
    by += 12;

    for (const line of data.sections.PROJECTS) {
      if (by > H - 100) { doc.addPage(); by = 50; doc.rect(0, 0, SW, H).fill(SC); }
      if (line.includes(" | ")) {
        by += 4;
        const parts = line.split("|").map((p) => p.trim());
        doc.fontSize(10.5).fillColor("#1B2838").font("Helvetica-Bold")
           .text(parts[0], BX, by, { width: BW });
        by = doc.y + 1;
        if (parts[1]) {
          doc.fontSize(8.5).fillColor(AC).font("Helvetica")
             .text(parts[1], BX, by, { width: BW });
          by = doc.y + 5;
        }
      } else if (line.startsWith("-") || line.startsWith("•")) {
        doc.fontSize(9).fillColor("#555").font("Helvetica")
           .text(`•  ${line.replace(/^[-•]\s*/, "")}`, BX + 10, by, { width: BW - 10, lineGap: 2 });
        by = doc.y + 4;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  TEMPLATE 2 — MODERN (gradient header)
// ═══════════════════════════════════════════════════════════════════════
function renderModern(doc, data, W, H) {
  const HH = 100, AC = "#00BFA5", MX = 45, CW = W - MX * 2;

  // Header background
  doc.rect(0, 0, W, HH).fill("#15202B");

  doc.fontSize(24).fillColor("#FFF").font("Helvetica-Bold").text(data.fullName, MX, 25, { width: CW });
  if (data.title) {
    doc.fontSize(10).fillColor(AC).font("Helvetica")
       .text(data.title.toUpperCase(), MX, doc.y + 2, { width: CW, characterSpacing: 1.2 });
  }
  const hContacts = [
    data.email !== "N/A" ? `Email: ${data.email}` : null,
    data.phone !== "N/A" ? `Phone: ${data.phone}` : null,
    data.location !== "N/A" ? `Loc: ${data.location}` : null,
  ].filter(Boolean);
  if (hContacts.length) {
    doc.fontSize(8).fillColor("#B0BEC5").text(hContacts.join("   |   "), MX, doc.y + 4, { width: CW });
  }

  let y = HH + 15;

  const secHead = (title) => {
    if (y > H - 80) { doc.addPage(); y = 40; }
    doc.fontSize(10.5).fillColor("#0F2027").font("Helvetica-Bold").text(title, MX, y, { width: CW });
    y = doc.y + 2;
    doc.moveTo(MX, y).lineTo(MX + 40, y).strokeColor(AC).lineWidth(2).stroke();
    doc.moveTo(MX + 42, y).lineTo(W - MX, y).strokeColor("#F0F0F0").lineWidth(0.5).stroke();
    y += 8;
  };

  if (data.sections.SUMMARY?.length) {
    secHead("SUMMARY");
    doc.fontSize(9).fillColor("#444").font("Helvetica")
       .text(data.sections.SUMMARY.join(" "), MX, y, { width: CW, lineGap: 2 });
    y = doc.y + 12;
  }

  if (data.sections.SKILLS?.length) {
    secHead("SKILLS");
    const skillsList = Array.isArray(data.sections.SKILLS) ? data.sections.SKILLS : [data.sections.SKILLS];
    let sx = MX;
    doc.fontSize(7.5).font("Helvetica");
    for (const skill of skillsList) {
      const tw = doc.widthOfString(skill) + 14;
      if (sx + tw > W - MX) { sx = MX; y += 18; }
      if (y > H - 40) { doc.addPage(); y = 40; sx = MX; }
      doc.roundedRect(sx, y, tw, 14, 2).fill("#F1F8E9");
      doc.fillColor("#2E7D32").text(skill, sx + 7, y + 3.5);
      sx += tw + 5;
    }
    y += 22;
  }

  if (data.sections.EXPERIENCE?.length) {
    secHead("EXPERIENCE");
    for (const line of data.sections.EXPERIENCE) {
      if (y > H - 80) { doc.addPage(); y = 40; }
      if (line.includes(" | ")) {
        const parts = line.split("|").map((p) => p.trim());
        doc.fontSize(9.5).fillColor("#1a1a2e").font("Helvetica-Bold")
           .text(parts[1] || parts[0], MX, y, { width: CW });
        y = doc.y + 1;
        doc.fontSize(8).fillColor(AC).font("Helvetica")
           .text([parts[0], parts[2]].filter(Boolean).join("  •  "), MX, y, { width: CW });
        y = doc.y + 4;
      } else if (line.startsWith("-") || line.startsWith("•")) {
        doc.fontSize(8.5).fillColor("#555").font("Helvetica")
           .text(`•  ${line.replace(/^[-•]\s*/, "")}`, MX + 8, y, { width: CW - 8, lineGap: 1.5 });
        y = doc.y + 3;
      }
    }
    y += 10;
  }

  if (data.sections.PROJECTS?.length) {
    secHead("PROJECTS");
    for (const line of data.sections.PROJECTS) {
      if (y > H - 80) { doc.addPage(); y = 40; }
      if (line.includes(" | ")) {
        const parts = line.split("|").map((p) => p.trim());
        doc.fontSize(9.5).fillColor("#1a1a2e").font("Helvetica-Bold")
           .text(parts[0], MX, y, { width: CW });
        y = doc.y + 1;
        if (parts[1]) {
          doc.fontSize(8).fillColor(AC).font("Helvetica")
             .text(parts[1], MX, y, { width: CW });
          y = doc.y + 4;
        }
      } else if (line.startsWith("-") || line.startsWith("•")) {
        doc.fontSize(8.5).fillColor("#555").font("Helvetica")
           .text(`•  ${line.replace(/^[-•]\s*/, "")}`, MX + 8, y, { width: CW - 8, lineGap: 1.5 });
        y = doc.y + 3;
      }
    }
    y += 10;
  }

  if (data.sections.EDUCATION?.length) {
    secHead("EDUCATION");
    for (const line of data.sections.EDUCATION) {
      if (y > H - 40) { doc.addPage(); y = 40; }
      doc.fontSize(9).fillColor("#333").font("Helvetica").text(line, MX, y, { width: CW });
      y = doc.y + 4;
    }
    y += 8;
  }

  if (data.sections.CERTIFICATIONS?.length) {
    secHead("CERTIFICATIONS");
    for (const c of data.sections.CERTIFICATIONS) {
      if (y > H - 30) { doc.addPage(); y = 40; }
      doc.fontSize(8.5).fillColor("#555").font("Helvetica").text(`•  ${c}`, MX, y, { width: CW });
      y = doc.y + 3;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  TEMPLATE 3 — MINIMAL (ATS-safe, clean)
// ═══════════════════════════════════════════════════════════════════════
function renderMinimal(doc, data, W, H) {
  const MX = 50, CW = W - MX * 2, DARK = "#222", MID = "#555";

  let y = 45;
  doc.fontSize(22).fillColor(DARK).font("Helvetica-Bold")
     .text(data.fullName.toUpperCase(), MX, y, { width: CW, align: "center", characterSpacing: 2 });
  y = doc.y + 4;
  if (data.title) {
    doc.fontSize(10).fillColor(MID).font("Helvetica")
       .text(data.title, MX, y, { width: CW, align: "center" });
    y = doc.y + 3;
  }
  const mContacts = [
    data.email !== "N/A" ? data.email : null,
    data.phone !== "N/A" ? data.phone : null,
    data.location !== "N/A" ? data.location : null,
    data.linkedin !== "N/A" ? "LinkedIn" : null,
  ].filter(Boolean);
  if (mContacts.length) {
    doc.fontSize(8.5).fillColor("#777").text(mContacts.join("   |   "), MX, y + 3, { width: CW, align: "center" });
    y = doc.y + 5;
  }
  y += 6;
  doc.moveTo(MX, y).lineTo(W - MX, y).strokeColor(DARK).lineWidth(1.5).stroke();
  y += 15;

  const secHead = (title) => {
    if (y > H - 100) { doc.addPage(); y = 45; }
    doc.fontSize(10).fillColor(DARK).font("Helvetica-Bold")
       .text(title.toUpperCase(), MX, y, { width: CW, characterSpacing: 1.5 });
    y = doc.y + 3;
    doc.moveTo(MX, y).lineTo(W - MX, y).strokeColor("#CCC").lineWidth(0.5).stroke();
    y += 8;
  };

  if (data.sections.SUMMARY?.length) {
    secHead("Professional Summary");
    doc.fontSize(9.5).fillColor(MID).font("Helvetica")
       .text(data.sections.SUMMARY.join(" "), MX, y, { width: CW, lineGap: 3 });
    y = doc.y + 15;
  }

  if (data.sections.SKILLS?.length) {
    secHead("Core Competencies");
    const skillsList = Array.isArray(data.sections.SKILLS) ? data.sections.SKILLS : [data.sections.SKILLS];
    const skills = skillsList.join(", ");
    doc.fontSize(9).fillColor(DARK).font("Helvetica")
       .text(skills, MX, y, { width: CW, lineGap: 2 });
    y = doc.y + 15;
  }

  if (data.sections.EXPERIENCE?.length) {
    secHead("Professional Experience");
    for (const line of data.sections.EXPERIENCE) {
      if (y > H - 100) { doc.addPage(); y = 45; }
      if (line.includes(" | ")) {
        const parts = line.split("|").map((p) => p.trim());
        doc.fontSize(10).fillColor(DARK).font("Helvetica-Bold")
           .text(parts[1] || parts[0], MX, y, { width: CW * 0.65 });
        if (parts[2]) {
          doc.fontSize(8.5).fillColor("#999").font("Helvetica")
             .text(parts[2], MX, doc.y - 12, { width: CW, align: "right" });
        }
        y = doc.y + 1;
        if (parts[0]) {
          doc.fontSize(9).fillColor(MID).font("Helvetica").text(parts[0], MX, y, { width: CW });
          y = doc.y + 4;
        }
      } else if (line.startsWith("-") || line.startsWith("•")) {
        doc.fontSize(9).fillColor(MID).font("Helvetica")
           .text(`•  ${line.replace(/^[-•]\s*/, "")}`, MX + 10, y, { width: CW - 10, lineGap: 2 });
        y = doc.y + 3;
      }
    }
    y += 12;
  }

  if (data.sections.PROJECTS?.length) {
    secHead("Projects");
    for (const line of data.sections.PROJECTS) {
      if (y > H - 100) { doc.addPage(); y = 45; }
      if (line.includes(" | ")) {
        const parts = line.split("|").map((p) => p.trim());
        doc.fontSize(10).fillColor(DARK).font("Helvetica-Bold")
           .text(parts[0], MX, y, { width: CW });
        y = doc.y + 1;
        if (parts[1]) {
          doc.fontSize(9).fillColor(MID).font("Helvetica").text(parts[1], MX, y, { width: CW });
          y = doc.y + 4;
        }
      } else if (line.startsWith("-") || line.startsWith("•")) {
        doc.fontSize(9).fillColor(MID).font("Helvetica")
           .text(`•  ${line.replace(/^[-•]\s*/, "")}`, MX + 10, y, { width: CW - 10, lineGap: 2 });
        y = doc.y + 3;
      }
    }
    y += 12;
  }

  if (data.sections.EDUCATION?.length) {
    secHead("Education");
    doc.fontSize(9.5).fillColor(MID).font("Helvetica");
    for (const line of data.sections.EDUCATION) {
      if (y > H - 60) { doc.addPage(); y = 45; }
      doc.text(line, MX, y, { width: CW }); y = doc.y + 5;
    }
    y += 10;
  }

  if (data.sections.CERTIFICATIONS?.length) {
    secHead("Certifications");
    doc.fontSize(9).fillColor(MID).font("Helvetica");
    for (const c of data.sections.CERTIFICATIONS) {
      if (y > H - 40) { doc.addPage(); y = 45; }
      doc.text(`•  ${c}`, MX, y, { width: CW }); y = doc.y + 4;
    }
  }
}

module.exports = { generatePDF };
