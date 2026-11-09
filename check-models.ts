import dotenv from "dotenv";
dotenv.config();

async function checkModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY environment variable.");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );

  if (!response.ok) {
    throw new Error(`HTTP error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const modelNames = data.models ? data.models.map((m: { name: string }) => m.name) : [];
  console.log(modelNames);
}

checkModels().catch(console.error);
