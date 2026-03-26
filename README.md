# 🎯 ATS Resume Analyzer Bot

A Telegram bot that analyzes your resume against a job description using AI and generates improved, professionally-designed PDF resumes.

## Features

- 📋 Paste a **Job Description** → Upload your **Resume** (PDF or image)
- 🤖 AI-powered ATS scoring & analysis (via Groq LLM)
- 📊 Score breakdown, missing keywords, and improvement suggestions
- 📄 **3 Premium PDF templates**: Professional, Modern, Minimal
- 🖼️ OCR support for image-based resumes (Tesseract.js)

## Tech Stack

| Tool | Purpose |
|------|---------|
| Node.js | Runtime |
| node-telegram-bot-api | Telegram integration |
| Groq (llama-3.3-70b) | AI analysis (free tier) |
| pdf-parse v2 | PDF text extraction |
| tesseract.js | OCR for images |
| pdfkit | PDF generation |

## Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/profaxen/job-bot.git
   cd job-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file:
   ```
   BOT_TOKEN=your_telegram_bot_token
   GROQ_API_KEY=your_groq_api_key
   ```

4. Start the bot:
   ```bash
   npm start
   ```

## Bot Flow

1. User sends `/start`
2. User pastes the **Job Description**
3. User uploads **Resume** (PDF or image)
4. Bot parses and analyzes resume vs JD
5. Bot returns **ATS Score + Suggestions**
6. Bot shows **template buttons**
7. User selects a template
8. Bot generates and sends **improved PDF**

## License

MIT
