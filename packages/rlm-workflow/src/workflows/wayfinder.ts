/**
 * @rlm/workflow — wayfinder workflow plugin.
 *
 * Map = GitHub issue on abhishakenp/prime-agent-runs, label: wayfinder:map
 * Tickets = child issues, labels: wayfinder:research, wayfinder:task,
 *           wayfinder:grilling, wayfinder:prototype
 * GitHub API via @octokit/rest
 * Claims = assignee; blocking = native GitHub deps or "Blocked by: #N" in body
 * Frontier = open + unblocked + unclaimed (no assignee)
 * Decisions so far = body section on map; resolution in ticket comment on close
 * Fleet bridge: wayfinder:task "build X" calls rlm.run with github-actions host
 */
import { Octokit } from "@octokit/rest";

// Runtime globals injected by rlm-workflow service
declare const define: (fn: (api: WorkflowApi) => WorkflowDef) => (api: WorkflowApi) => Workflow;
declare function emit(event: string, data: unknown): void;

interface WorkflowApi {
  sdk: {
    run: (prompt: string, opts?: SpawnOptions) => Promise<SubagentHandle>;
    spawn: (prompt: string, opts?: SpawnOptions) => Promise<string>;
    listSubagents: () => Promise<SubagentInfo[]>;
    deleteSubagent: (target: string) => Promise<void>;
    goal: {
      create: (objective: string, opts?: { tokenBudget?: number }) => Promise<void>;
      get: () => Promise<GoalInfo | null>;
      complete: () => Promise<void>;
      pause: () => Promise<void>;
    };
  };
  ctx: unknown;
  emit: (event: string, data: unknown) => void;
}

interface WorkflowDef {
  name: string;
  run: (input: string) => Promise<string>;
}

interface Workflow {
  name: string;
  run: (input: string) => Promise<string>;
}

interface SpawnOptions {
  name?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  depth?: number;
  context?: string[];
  contextMove?: string[];
  host?: string;
  env?: Record<string, string>;
}

interface SubagentHandle {
  id: string;
  name: string;
  status: "running" | "completed" | "error";
  result?: string;
}

interface SubagentInfo {
  id: string;
  name: string;
  status: "running" | "completed" | "error";
  sessionName: string;
}

interface GoalInfo {
  id?: string;
  objective: string;
  status: "idle" | "active" | "paused" | "complete" | "error";
  tokenBudget?: number;
  tokensUsed: number;
}

function getLabelName(label: string | { name?: string }): string {
  return typeof label === "string" ? label : label.name || "";
}

export default define((api: WorkflowApi) => ({
  name: "wayfinder",
  async run(input: string): Promise<string> {
    const { sdk } = api;
    const token = process.env.GH_TOKEN;
    if (!token) {
      throw new Error("GH_TOKEN not set");
    }

    const octokit = new Octokit({ auth: token });
    const OWNER = "abhishakenp";
    const REPO = "prime-agent-runs";

    const parts = input.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    if (cmd === "chart") {
      return await chartMap(octokit, OWNER, REPO, parts.slice(1).join(" "));
    } else if (cmd === "work") {
      const mapNum = parseInt(parts[1]);
      const ticketNum = parts[2] ? parseInt(parts[2]) : undefined;
      return await workMap(octokit, OWNER, REPO, mapNum, ticketNum, sdk);
    } else if (cmd === "claim") {
      const ticketNum = parseInt(parts[1]);
      return await claimTicket(octokit, OWNER, REPO, ticketNum);
    } else if (cmd === "resolve") {
      const ticketNum = parseInt(parts[1]);
      const resolution = parts.slice(2).join(" ");
      return await resolveTicket(octokit, OWNER, REPO, ticketNum, resolution);
    } else {
      return "Usage: wayfinder chart <destination> | work <map-number> [ticket] | claim <ticket> | resolve <ticket> <resolution>";
    }
  },
}));

async function chartMap(octokit: InstanceType<typeof Octokit>, owner: string, repo: string, destination: string): Promise<string> {
  const mapBody = `## Destination

${destination || "TBD: describe what reaching the end of this map looks like"}

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index: one line per closed ticket -->

## Not yet specified

<!-- fog: in-scope decisions not yet sharp enough to ticket -->

## Out of scope

<!-- work ruled beyond the destination -->
`;

  const mapIssue = await octokit.issues.create({
    owner,
    repo,
    title: `[Wayfinder Map] ${destination?.slice(0, 50) || "New map"}`,
    body: mapBody,
    labels: ["wayfinder:map"],
  });

  const mapNum = mapIssue.data.number;
  emit("wayfinder:map-created", { number: mapNum, url: mapIssue.data.html_url });

  return `Map created: #${mapNum} (${mapIssue.data.html_url})

Frontier is empty. Use "work ${mapNum}" to start charting decisions.`;
}

async function workMap(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  mapNum: number,
  ticketNum: number | undefined,
  sdk: WorkflowApi["sdk"]
): Promise<string> {
  if (ticketNum) {
    return await workTicket(octokit, owner, repo, mapNum, ticketNum, sdk);
  }

  const frontier = await findFrontier(octokit, owner, repo);

  if (frontier.length === 0) {
    return `#${mapNum}: Map complete. All tickets resolved.`;
  }

  const next = frontier[0];
  const typeLabel = next.labels
    .map(getLabelName)
    .find((name: string) => name.startsWith("wayfinder:")) || "no-type";

  return `#${mapNum} frontier:

- [#${next.number}: ${next.title}](${next.html_url}) [${typeLabel}]
`;
}

async function workTicket(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  _mapNum: number,
  ticketNum: number,
  sdk: WorkflowApi["sdk"]
): Promise<string> {
  const ticket = await octokit.issues.get({ owner, repo, issue_number: ticketNum });
  const labelNames = ticket.data.labels?.map(getLabelName) || [];
  const typeLabel = labelNames.find((l: string) => l.startsWith("wayfinder:"));
  const body = ticket.data.body || "";

  const blockedMatch = body.match(/Blocked by: #(\d+)/i);
  if (blockedMatch) {
    const blockerNum = parseInt(blockedMatch[1]);
    const blocker = await octokit.issues.get({ owner, repo, issue_number: blockerNum });
    if (blocker.data.state !== "closed") {
      return `#${ticketNum} is blocked by #${blockerNum} (${blocker.data.title}). Resolve that first.`;
    }
  }

  if (typeLabel === "wayfinder:task") {
    const buildMatch = body.match(/build (.+)/i);
    if (buildMatch) {
      const buildTarget = buildMatch[1];
      emit("wayfinder:fleet-task", { ticket: ticketNum, target: buildTarget });
      const ghToken = process.env.GH_TOKEN!;
      const handle = await sdk.run(`Build and test: ${buildTarget}`, {
        name: `build-${ticketNum}`,
        host: "github-actions",
        env: { GH_TOKEN: ghToken },
      });
      return `Fleet task spawned for #${ticketNum}. Handle: ${handle.id}`;
    }
  }

  return `#${ticketNum}: ${ticket.data.title}

Type: ${typeLabel || "unknown"}
Assignee: ${ticket.data.assignee?.login || "unclaimed"}

---

${body}
`;
}

async function claimTicket(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  ticketNum: number
): Promise<string> {
  const { data: user } = await octokit.users.getAuthenticated();

  await octokit.issues.addAssignees({
    owner,
    repo,
    issue_number: ticketNum,
    assignees: [user.login],
  });

  return `Claimed #${ticketNum} as ${user.login}`;
}

async function resolveTicket(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  ticketNum: number,
  resolution: string
): Promise<string> {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: ticketNum,
    body: `## Resolution

${resolution}

Resolved by wayfinder workflow.
`,
  });

  await octokit.issues.update({
    owner,
    repo,
    issue_number: ticketNum,
    state: "closed",
  });

  return `Resolved and closed #${ticketNum}`;
}

interface TicketIssue {
  number: number;
  title: string;
  body: string | null | undefined;
  state: string;
  html_url: string;
  assignee: { login: string } | null;
  labels: (string | { name?: string })[];
}

async function findFrontier(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string
): Promise<TicketIssue[]> {
  const ticketLabels = ["wayfinder:research", "wayfinder:task", "wayfinder:grilling", "wayfinder:prototype"];

  const { data: allTickets } = await octokit.issues.listForRepo({
    owner,
    repo,
    labels: ticketLabels.join(","),
    state: "open",
  });

  const openTicketNums = new Set(allTickets.map(t => t.number));
  const frontier: TicketIssue[] = [];

  for (const ticket of allTickets) {
    if (ticket.assignee) continue;

    const body = ticket.body || "";
    const blockedMatch = body.match(/Blocked by: #(\d+)/i);
    if (blockedMatch) {
      const blockerNum = parseInt(blockedMatch[1]);
      if (openTicketNums.has(blockerNum)) continue;
    }

    frontier.push({
      number: ticket.number,
      title: ticket.title,
      body: ticket.body,
      state: ticket.state,
      html_url: ticket.html_url,
      assignee: ticket.assignee,
      labels: ticket.labels,
    });
  }

  return frontier;
}
