import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";

interface CredentialEntry {
  apiKey: string;
  baseUrl?: string;
}

interface CredentialsConfig {
  groq?: CredentialEntry;
  cerebras?: CredentialEntry;
  omniroute?: CredentialEntry;
}

const CREDENTIALS_PATH = join(homedir(), ".rlm", "credentials.json");

export function loadRlmCredentials(): CredentialsConfig {
  if (!existsSync(CREDENTIALS_PATH)) {
    return {};
  }
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(raw) as CredentialsConfig;
  } catch {
    return {};
  }
}

export function applyCredentialsAsEnvVars(): void {
  const creds = loadRlmCredentials();

  if (creds.groq?.apiKey) {
    process.env.GROQ_API_KEY = creds.groq.apiKey;
    if (creds.groq.baseUrl) {
      process.env.GROQ_BASE_URL = creds.groq.baseUrl;
    }
  }

  if (creds.cerebras?.apiKey) {
    process.env.CEREBRAS_API_KEY = creds.cerebras.apiKey;
    if (creds.cerebras.baseUrl) {
      process.env.CEREBRAS_BASE_URL = creds.cerebras.baseUrl;
    }
  }

  if (creds.omniroute?.apiKey) {
    process.env.OMNIROUTE_API_KEY = creds.omniroute.apiKey;
    if (creds.omniroute.baseUrl) {
      process.env.OMNIROUTE_BASE_URL = creds.omniroute.baseUrl;
    }
  }
}

// groq.*cerebras.*omniroute key reuse: all three providers use the same
// credentials.ts mechanism to load their API keys from ~/.rlm/credentials.json
// and expose them as environment variables for the AI provider layer.
