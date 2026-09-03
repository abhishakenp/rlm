import { Service } from "@deepseek-ai/cordis";
import * as fs from "fs";
import { execSync } from "child_process";

// Command schema interface
export interface CommandSchema {
  name: string;
  description?: string;
  parameters?: readonly string[];
  examples?: readonly string[];
  signature?: string;
}

// Command registry - accessible to handle method
const COMMANDS: CommandSchema[] = [
  {
    name: "list",
    description: "List all iris resources",
    parameters: ["--json", "--filter"],
    examples: ["list", "list --json"],
    signature: "list [--json] [--filter <pattern>]"
  },
  {
    name: "get",
    description: "Get iris resource by ID",
    parameters: ["<id>", "--json"],
    examples: ["get 123", "get 123 --json"],
    signature: "get <id> [--json]"
  },
  {
    name: "create",
    description: "Create new iris resource",
    parameters: ["--name", "--type"],
    examples: ["create --name \"my resource\""],
    signature: "create [--name <name>] [--type <type>]"
  },
  {
    name: "proc list",
    description: "List running subagents from the rlm system",
    parameters: [],
    examples: ["proc list"],
    signature: "proc list"
  },
  {
    name: "rlm inflight",
    description: "Get in-flight subagents as JSON",
    parameters: [],
    examples: ["iris rlm inflight"],
    signature: "iris rlm inflight"
  },
  {
    name: "commands",
    description: "List all available iris commands",
    parameters: [],
    examples: ["commands"],
    signature: "commands"
  },
  {
    name: "terminal.status",
    description: "Get status of terminal windows and tabs",
    parameters: [],
    examples: ["terminal.status"],
    signature: "terminal.status"
  },
  {
    name: "desktop.find",
    description: "Search for windows/tabs across apps matching a query",
    parameters: ["query=<search_term>"],
    examples: ["desktop.find query=claude", "desktop.find query=github"],
    signature: "desktop.find query=<search_term>"
  },
  {
    name: "config.speech",
    description: "Configure speech recognition settings",
    parameters: ["--rate", "--pitch", "--volume"],
    examples: ["config speech --rate 1.0"],
    signature: "config.speech [--rate <rate>] [--pitch <pitch>] [--volume <volume>]"
  },
  {
    name: "config.voice",
    description: "Configure voice synthesis settings",
    parameters: ["--voice-id", "--language"],
    examples: ["config voice --voice-id default --language en-US"],
    signature: "config.voice [--voice-id <id>] [--language <lang>]"
  },
  {
    name: "config.brain",
    description: "Configure brain/AI model settings",
    parameters: ["--model", "--temperature"],
    examples: ["config brain --model default --temperature 0.7"],
    signature: "config.brain [--model <model>] [--temperature <temp>]"
  },
  {
    name: "recall.match",
    description: "Match and recall stored patterns",
    parameters: ["--pattern", "--limit"],
    examples: ["recall match --pattern speech"],
    signature: "recall.match [--pattern <pattern>] [--limit <n>]"
  },
  {
    name: "recall.speech",
    description: "Recall speech recognition patterns",
    parameters: ["--pattern", "--limit"],
    examples: ["recall speech --limit 10"],
    signature: "recall.speech [--pattern <pattern>] [--limit <n>]"
  },
  {
    name: "recall.voice",
    description: "Recall voice synthesis patterns",
    parameters: ["--pattern", "--limit"],
    examples: ["recall voice --limit 10"],
    signature: "recall.voice [--pattern <pattern>] [--limit <n>]"
  },
  {
    name: "recall.brain",
    description: "Recall brain/AI model patterns",
    parameters: ["--pattern", "--limit"],
    examples: ["recall brain --limit 10"],
    signature: "recall.brain [--pattern <pattern>] [--limit <n>]"
  },
  {
    name: "transcript",
    description: "Manage agent transcripts",
    parameters: [],
    examples: ["transcript"],
    signature: "transcript"
  },
  {
    name: "error",
    description: "View and manage agent errors",
    parameters: [],
    examples: ["error"],
    signature: "error"
  },
  {
    name: "evolve",
    description: "Trigger harness self-evolution",
    parameters: [],
    examples: ["evolve"],
    signature: "evolve"
  },
  {
    name: "speak",
    description: "Generate audio from text using TTS",
    parameters: ["<text>"],
    examples: ["speak hello world"],
    signature: "speak <text>"
  }
];

// Helper functions
function runAppleScript(script: string): string {
  try {
    const result = execSync(`osascript -s s << 'SCRIPT'
${script}
SCRIPT`, {
      timeout: 5000,
      encoding: "utf8",
    });
    return result.trim();
  } catch (error: any) {
    return `AppleScript error: ${error.message}`;
  }
}

function runCommand(cmd: string): string {
  try {
    const result = execSync(cmd, { timeout: 3000, encoding: "utf8" });
    return result.trim();
  } catch (error: any) {
    return `Command error: ${error.message}`;
  }
}

export class IrisCommands extends Service {
  static provide() {
    return {
      iris: {
        handle: async (args: string): Promise<string> => {
          const parts = args.trim().split(/\s+/);
          const cmd = parts[0];
          const subArgs = parts.slice(1).join(" ");

          // Handle "commands" to list all available commands
          if (cmd === "commands") {
            return JSON.stringify(COMMANDS.map(c => ({
              name: c.name,
              description: c.description,
              parameters: c.parameters,
              examples: c.examples,
              signature: c.signature
            })), null, 2);
          }

          if (cmd === "proc" && subArgs === "list") {
            const ctx = (this as any).ctx;
            const sdk = ctx?.get?.("rlmSdk");
            if (!sdk) {
              return JSON.stringify({ error: "rlm-sdk not available" });
            }
            try {
              const subagents = sdk.listSubagents();
              return JSON.stringify(subagents);
            } catch (error) {
              return JSON.stringify({ error: `Failed to list subagents: ${error instanceof Error ? error.message : String(error)}` });
            }
          }

          if (cmd === "rlm" && subArgs === "inflight") {
            const ctx = (this as any).ctx;
            const sdk = ctx?.get?.("rlmSdk");
            if (!sdk) {
              return JSON.stringify({ error: "rlm-sdk not available" });
            }
            const inFlight = sdk.inFlight();
            return JSON.stringify({ inFlight });
          }

          // terminal.status command - get terminal window/tab info
          if (cmd === "terminal" && parts[1] === "status") {
            const script = `
tell application "Terminal"
    set result to {windows: 0, tabs: 0, running: false}
    try
        set isRunning to (exists application process "Terminal")
        if isRunning then
            set result's running to true
            set wCount to count of windows
            set result's windows to wCount
            if wCount > 0 then
                set tCount to 0
                repeat with w in windows
                    set tCount to tCount + (count of tabs of w)
                end repeat
                set result's tabs to tCount
            end if
        end if
    on error
        set result's running to false
    end try
    return result
end tell
`;
            const output = runAppleScript(script);

            let terminalRunning = false;
            let pid: string | null = null;
            try {
              pid = runCommand("pgrep -x Terminal").split('\n')[0];
              terminalRunning = pid.length > 0;
            } catch {
              terminalRunning = false;
            }

            let windowCount = 0;

            if (output && !output.includes("error")) {
              const match = output.match(/windows:(\d+)/);
              if (match) windowCount = parseInt(match[1]);
            }

            return JSON.stringify({
              command: "terminal.status",
              status: terminalRunning ? "running" : "stopped",
              windows: windowCount,
              tabs: 0,
              pid: pid || null
            });
          }

          // desktop.find command - search for windows/tabs matching query
          if (cmd === "desktop" && parts[1] === "find") {
            const queryMatch = subArgs.match(/query=([^\s]+)/);
            const query = queryMatch ? queryMatch[1] : "";

            if (!query) {
              return JSON.stringify({ error: "desktop.find requires a query parameter", usage: "iris desktop.find query=<search_term>" });
            }

            const matches: Array<{ app: string; window: string; type: string }> = [];

            const appsToCheck = [
              { name: "Terminal", script: `
                tell application "Terminal"
                  set wList to {}
                  repeat with w in windows
                    repeat with t in tabs of w
                      set tabTitle to (t's custom title as string)
                      if tabTitle contains "${query}" then
                        set end of wList to {window: (id of w as string), title: tabTitle, tab: (index of t as string)}
                      end if
                    end repeat
                  end repeat
                  return wList
                end tell
              `},
              { name: "Safari", script: `
                tell application "Safari"
                  set wList to {}
                  repeat with w in windows
                    set tabTitles to ""
                    repeat with t in tabs of w
                      set tabTitles to tabTitles & (t's name as string) & " "
                    end repeat
                    if tabTitles contains "${query}" then
                      set end of wList to {window: (id of w as string), title: (w's name as string)}
                    end if
                  end repeat
                  return wList
                end tell
              `},
              { name: "Google Chrome", script: `
                tell application "Google Chrome"
                  set wList to {}
                  repeat with w in windows
                    repeat with t in tabs of w
                      set tabTitle to (t's title as string)
                      if tabTitle contains "${query}" then
                        set end of wList to {window: (id of w as string), title: tabTitle, tab: (index of t as string)}
                      end if
                    end repeat
                  end repeat
                  return wList
                end tell
              `},
              { name: "Arc", script: `
                tell application "Arc"
                  set wList to {}
                  repeat with w in windows
                    set wName to (w's name as string)
                    if wName contains "${query}" then
                      set end of wList to {window: "arc-window", title: wName}
                    end if
                  end repeat
                  return wList
                end tell
              `},
              { name: "Finder", script: `
                tell application "Finder"
                  set wList to {}
                  try
                    repeat with w in Finder windows
                      set wName to (name of w as string)
                      if wName contains "${query}" then
                        set end of wList to {window: "finder", title: wName}
                      end if
                    end repeat
                  end try
                  return wList
                end tell
              `}
            ];

            for (const app of appsToCheck) {
              try {
                const output = runAppleScript(app.script);
                if (output && !output.includes("error") && output !== "{}" && output !== "" && output !== "missing value") {
                  matches.push({
                    app: app.name,
                    window: output.substring(0, 100),
                    type: "tab"
                  });
                }
              } catch {
                // Skip apps that error
              }
            }

            return JSON.stringify({
              command: "desktop.find",
              query: query,
              matches: matches,
              count: matches.length,
              status: matches.length > 0 ? "found" : "not_found"
            });
          }

          // config.* commands
          if (cmd === "config") {
            const configCmd = subArgs.split(/\s+/)[0];
            if (configCmd === "speech") {
              return JSON.stringify({
                command: "config.speech",
                status: "configured",
                settings: { rate: 1.0, pitch: 1.0, volume: 0.8 }
              });
            }
            if (configCmd === "voice") {
              return JSON.stringify({
                command: "config.voice",
                status: "configured",
                settings: { voice_id: "default", language: "en-US" }
              });
            }
            if (configCmd === "brain") {
              return JSON.stringify({
                command: "config.brain",
                status: "configured",
                settings: { model: "default", temperature: 0.7 }
              });
            }
          }

          // recall.* commands
          if (cmd === "recall") {
            const recallCmd = subArgs.split(/\s+/)[0];
            if (recallCmd === "match") {
              return JSON.stringify({
                command: "recall.match",
                status: "matched",
                matches: []
              });
            }
            if (recallCmd === "speech") {
              return JSON.stringify({
                command: "recall.speech",
                status: "recalled",
                patterns: []
              });
            }
            if (recallCmd === "voice") {
              return JSON.stringify({
                command: "recall.voice",
                status: "recalled",
                patterns: []
              });
            }
            if (recallCmd === "brain") {
              return JSON.stringify({
                command: "recall.brain",
                status: "recalled",
                patterns: []
              });
            }
          }

          if (cmd === "transcript") {
            return JSON.stringify({
              command: "transcript",
              status: "available",
              usage: "iris transcript"
            });
          }

          if (cmd === "error") {
            return JSON.stringify({
              command: "error",
              status: "available",
              usage: "iris error"
            });
          }

          if (cmd === "evolve") {
            return JSON.stringify({
              command: "evolve",
              status: "available",
              usage: "iris evolve"
            });
          }

          // Handle "speak" command - TTS generation using macOS say command
          if (cmd === "speak") {
            const argsStr = args.trim();
            const speakIdx = argsStr.indexOf('speak');
            const text = argsStr.slice(speakIdx + 5).trim();

            if (!text) {
              return JSON.stringify({ error: "No text provided for speak command" });
            }

            const tempAiff = '/tmp/iris-speak-temp-' + Date.now() + '.aiff';
            const wavOutput = '/tmp/iris-speak-output.wav';

            try {
              const escapedText = text.replace(/"/g, '\\"');
              execSync('say -o "' + tempAiff + '" "' + escapedText + '"', { timeout: 10000 });
              execSync('afconvert "' + tempAiff + '" "' + wavOutput + '"', { timeout: 10000 });
              const durationStr = execSync('soxi -D "' + wavOutput + '"').toString().trim();
              const duration = parseFloat(durationStr);
              try { fs.unlinkSync(tempAiff); } catch {}
              return JSON.stringify({ path: wavOutput, duration: isNaN(duration) ? 0 : duration });
            } catch (error: any) {
              try { fs.unlinkSync(tempAiff); } catch {}
              return JSON.stringify({ error: "Failed to generate audio: " + error.message });
            }
          }

          return JSON.stringify({ error: `Unknown command: ${cmd}` });
        },

        commands: COMMANDS
      }
    };
  }
}

export default IrisCommands;
export const name = "iris-commands";
