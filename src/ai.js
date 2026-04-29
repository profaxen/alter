const axios = require("axios");
const logger = require("./logger");
const { sanitizeForPrompt } = require("./validator");
const { GROQ_URL, GROQ_MODEL, GROQ_TIMEOUT, GROQ_RETRY_MAX, GROQ_RETRY_BASE_DELAY } = require("./config");

async function callGroq(messages, options = {}) {
  const { maxTokens = 1000, temperature = 0.4, responseFormat } = options;

  for (let attempt = 1; attempt <= GROQ_RETRY_MAX; attempt++) {
    try {
      const payload = { 
        model: GROQ_MODEL, 
        max_tokens: maxTokens, 
        temperature, 
        messages 
      };
      
      if (responseFormat) {
        payload.response_format = { type: responseFormat };
      }

      const response = await axios.post(
        GROQ_URL,
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: GROQ_TIMEOUT,
        }
      );

      const reply = response.data.choices?.[0]?.message?.content;
      if (!reply) throw new Error("Groq returned empty response");
      return reply;

    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || status >= 500 || err.code === "ECONNABORTED";

      if (attempt < GROQ_RETRY_MAX && retryable) {
        const delay = GROQ_RETRY_BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 1000;
        logger.warn(`Groq attempt ${attempt} failed, retrying in ${Math.round(delay)}ms`, { status, code: err.code });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ─── Intent Analysis ────────────────────────────────────────────────────────
async function analyzeIntent(userInput) {
  const safeInput = sanitizeForPrompt(userInput).substring(0, 500);
  const messages = [
    {
      role: "system",
      content: "Classify the user's intent into EXACTLY ONE of the following keywords: [PROVIDE_INFO, ASK_QUESTION, REQUEST_GENERATE, EDIT_FIELD, UNKNOWN]. Return ONLY the keyword, nothing else."
    },
    {
      role: "user",
      content: `<USER_INPUT_START>${safeInput}<USER_INPUT_END>`
    }
  ];

  try {
    const reply = await callGroq(messages, { temperature: 0.0, maxTokens: 10 });
    const intent = reply.trim().toUpperCase();
    const validIntents = ["PROVIDE_INFO", "ASK_QUESTION", "REQUEST_GENERATE", "EDIT_FIELD", "UNKNOWN"];
    return validIntents.includes(intent) ? intent : "UNKNOWN";
  } catch (err) {
    logger.error("Intent analysis failed", { error: err.message });
    return "UNKNOWN";
  }
}

// ─── Profile Extraction & Refinement ───────────────────────────────────────
async function extractProfileData(userInput, currentProfile, chatHistoryText) {
  const safeInput = sanitizeForPrompt(userInput).substring(0, 4000);
  
  const messages = [
    {
      role: "system",
      content: `You are a premium, production-grade AI Resume Expert and Executive Writer. 
Your job is to transform user input into a professional, industry-level resume profile.

CRITICAL RULES:
1. NEVER INVENT FACTS: Do not hallucinate metrics, companies, years, or roles.
2. UPGRADE WORDING: Transform weak, casual descriptions into strong, professional, action-oriented bullet points using industry-standard verbs.
3. EXPAND CONTENT: For every work experience or project, generate at least 3-4 high-impact, detailed bullet points. If the user provides 1 line, expand it into 3-4 professional lines based on standard industry responsibilities for that role.
4. ATS-FRIENDLY: Ensure the structure and language are optimized for Applicant Tracking Systems.
5. MERGE INTELLIGENTLY: Integrate new info into the existing profile.
6. COMPLETE JSON: Return the full, merged profile in JSON.

Schema:
{
  "full_name": "string or null",
  "email": "string or null",
  "phone": "string or null",
  "location": "string or null",
  "links": { "linkedin": "string or null", "portfolio": "string or null", "github": "string or null" },
  "summary": "string or null",
  "skills": ["string"] or null,
  "experience": [{"company": "...", "title": "...", "dates": "...", "location": "...", "bullets": ["..."]}] or null,
  "education": [{"degree": "...", "school": "...", "year": "...", "location": "..."}] or null,
  "projects": [{"name": "...", "description": "...", "technologies": ["..."], "link": "..."}] or null,
  "certifications": ["string"] or null,
  "languages": ["string"] or null
}
Return ONLY raw JSON.`
    },
    {
      role: "user",
      content: `Current Profile Context: ${JSON.stringify(currentProfile)}
Chat History Context: ${chatHistoryText}

<USER_INPUT_START>
${safeInput}
<USER_INPUT_END>`
    }
  ];

  try {
    const reply = await callGroq(messages, { temperature: 0.1, responseFormat: "json_object" });
    const cleanJson = reply.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleanJson);
  } catch (err) {
    logger.error("Data extraction failed", { error: err.message });
    return null;
  }
}

// ─── Conversational AI Response ─────────────────────────────────────────────
async function generateChatResponse(currentProfile, chatHistoryText, isReadyToGenerate) {
  const missingFields = [];
  if (!currentProfile.full_name) missingFields.push("Full Name");
  if (!currentProfile.email && !currentProfile.phone) missingFields.push("Contact Details");
  if (!currentProfile.summary) missingFields.push("Professional Summary");
  if (!currentProfile.skills || currentProfile.skills.length === 0) missingFields.push("Skills");
  if (!currentProfile.experience || currentProfile.experience.length === 0) missingFields.push("Work Experience or Projects");

  const messages = [
    {
      role: "system",
      content: `You are a premium, friendly, and highly intelligent AI Career Coach. 
Your goal is to guide the user to build a professional resume through a natural, smart conversation.

CORE STRATEGY:
- Be concise, helpful, and premium.
- Use the provided profile context to avoid repeating questions.
- If data is missing (${missingFields.join(", ")}), ask for the most useful next piece of information (max 1-2 questions).
- If the profile is strong, suggest a preview or ask if they want to 'generate' the final version.
- If the user provides messy or weak info, acknowledge it and mention you've upgraded it professionally.
- Support a smooth, modern product feel. Avoid sounding like a form or a bot.

Current Profile: ${JSON.stringify(currentProfile)}
Chat History:
${chatHistoryText}`
    }
  ];

  try {
    const reply = await callGroq(messages, { temperature: 0.4 });
    return reply.trim();
  } catch (err) {
    logger.error("Chat response failed", { error: err.message });
    return "I'm here to help you build a premium resume. Could you tell me a bit more about your background?";
  }
}

module.exports = { analyzeIntent, extractProfileData, generateChatResponse };
