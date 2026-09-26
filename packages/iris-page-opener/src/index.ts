import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Service } from "@deepseek-ai/cordis";

const execFileAsync = promisify(execFile);

/** The agent-browser binary; override with IRIS_AGENT_BROWSER (tests use a fake). */
const agentBrowser = (): string => process.env.IRIS_AGENT_BROWSER ?? "agent-browser";

/**
 * Result types that iris-page-opener can handle
 */
export interface SearchResult {
  type: "search";
  url: string;
  title?: string;
  snippet?: string;
}

export interface DocumentResult {
  type: "document";
  url: string;
  filename?: string;
  contentType?: string;
}

export interface MessageResult {
  type: "message";
  url: string;
  platform?: string;
  threadId?: string;
}

export interface GenericResult {
  type?: string;
  url: string;
  [key: string]: unknown;
}

export type JobResult = SearchResult | DocumentResult | MessageResult | GenericResult;

/**
 * Open a single URL in the browser using agent-browser CLI
 */
export async function openPage(url: string, options: { headless?: boolean } = {}): Promise<void> {
  const args = [
    "--session", "iris-page-opener",
    "open",
    url
  ];
  
  if (options.headless) {
    args.unshift("--engine", "lightpanda");
  }
  
  // execFile, not a shell string: a URL with `;`, `$()` or quotes must stay one argument.
  await execFileAsync(agentBrowser(), args);
}

/**
 * Open multiple URLs (batch operation) in the browser
 */
export async function openResults(
  urls: string[],
  options: { headless?: boolean; delay?: number } = {}
): Promise<void> {
  const { delay = 500 } = options;
  
  for (const url of urls) {
    await openPage(url, { headless: options.headless });
    // Small delay between page opens to avoid overwhelming the browser
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/**
 * Parse and categorize job results by their type
 */
export function categorizeResults(results: JobResult[]): {
  search: JobResult[];
  documents: JobResult[];
  messages: JobResult[];
  generic: JobResult[];
} {
  const categorized = {
    search: [] as JobResult[],
    documents: [] as JobResult[],
    messages: [] as JobResult[],
    generic: [] as JobResult[]
  };

  for (const result of results) {
    switch (result.type) {
      case "search":
        categorized.search.push(result);
        break;
      case "document":
        categorized.documents.push(result);
        break;
      case "message":
        categorized.messages.push(result);
        break;
      default:
        categorized.generic.push(result);
    }
  }

  return categorized;
}

/**
 * Extract URLs from various result formats
 */
export function extractUrls(results: JobResult[]): string[] {
  return results.map(r => r.url).filter((url): url is string => Boolean(url));
}

/**
 * Open job results in the browser, grouped by type
 */
export async function openJobResults(
  results: JobResult[],
  options: { headless?: boolean; groupByType?: boolean } = {}
): Promise<void> {
  if (options.groupByType) {
    const categorized = categorizeResults(results);
    
    // Open each category
    for (const urls of Object.values(categorized)) {
      const pageUrls = extractUrls(urls);
      if (pageUrls.length > 0) {
        await openResults(pageUrls, options);
      }
    }
  } else {
    // Open all URLs directly
    const urls = extractUrls(results);
    await openResults(urls, options);
  }
}

/**
 * `irisPageOpener` — open job results (search hits, documents, messages) in the
 * browser through agent-browser, on its own named session.
 */
export class IrisPageOpener extends Service {
  // The iris family's shape (see iris-attention, which coding-agent's config.ts
  // reads the same way): `provide()` hands out the namespaced functions.
  static provide() {
    return {
      iris: {
        pageOpener: {
          openPage,
          openResults,
          openJobResults,
          categorizeResults,
          extractUrls,
        },
      },
    };
  }
}

export default IrisPageOpener;
export const name = "iris-page-opener";
