/**
 * GitHub Actions runtime adapter — deploys self-contained agent bundles as workflow runs.
 *
 * The bundle is committed to a temp branch or uploaded as a workflow artifact.
 * The workflow:
 * - Checks out the bundle
 * - Runs ./run.sh
 * - Uploads results as artifacts
 *
 * Spin-up: ~10-30s (runner allocation)
 * The target (GH Actions) needs nothing — the bundle IS the workflow.
 */

import { execSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentIdentitySpec,
	assembleBundle,
	type BundleSpec,
	tarBundle,
} from "../../core/fleet-runtime/agent-bundle.js";
import type {
	AgentEvent,
	AgentIdentity,
	AgentRuntime,
	AgentStatus,
	AgentStatusEndpoint,
	AgentStatusInfo,
	SpawnRequest,
	SpawnResult,
} from "../../core/fleet-runtime/agent-runtime.js";
import {
	ensureAccount,
	isProvisionerAlive,
	type LeasedAccount,
	releaseAccount,
} from "../../core/fleet-runtime/provisioner-client.js";

export interface GitHubActionsRuntimeConfig {
	token?: string;
	repo?: string;
	gatewayUrl?: string;
	gatewayAuthToken?: string;
	/** Maximum concurrent workflow runs before queueing (default: 10) */
	maxConcurrent?: number;
	/** Label for queued task issues (default: rlm-task) */
	queueLabel?: string;
	/** Disable queuing - throw error instead (default: false) */
	noQueue?: boolean;
}

export class GitHubActionsRuntime implements AgentRuntime {
	readonly platform = "github-actions";
	private readonly config: GitHubActionsRuntimeConfig;

	constructor(config: GitHubActionsRuntimeConfig = {}) {
		this.config = config;
	}

	canSpawn(host: string): boolean {
		return host === "github-actions" || host === "github" || host === "gha" || host.startsWith("github:");
	}

	async spawn(request: SpawnRequest): Promise<SpawnResult> {
		const agentId = crypto.randomUUID();
		const sessionDir = request.workDir ?? `.rlm/sessions/gha/${agentId}`;

		const identity: AgentIdentity = {
			agentId,
			host: "github-actions",
			sessionDir,
			model: request.model ?? "default",
			label: request.name ?? request.prompt.slice(0, 60),
			depth: request.depth,
			parentAgentId: request.parent?.agentId,
		};

		// Assemble the bundle
		const identitySpec: AgentIdentitySpec = {
			agentId,
			host: "github-actions",
			hardwareId: "github-runner",
			depth: request.depth,
			parentAgentId: request.parent?.agentId,
			parentHost: request.parent?.host,
		};

		const bundleSpec: BundleSpec = {
			prompt: request.prompt,
			identity: identitySpec,
			model: request.model,
			name: request.name,
			workDir: request.workDir,
			files: request.syncFiles,
			// Credentials are NOT embedded in the tarball — they're passed via GitHub secrets
			includeCredentials: false,
			cwd: process.cwd(),
		};

		const bundleDir = await assembleBundle(bundleSpec);
		const tarPath = await tarBundle(bundleDir);

		// Read bundle contents
		const settings = JSON.parse(readFileSync(join(bundleDir, "agent", "settings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		const prompt = readFileSync(join(bundleDir, "agent", "prompt.txt"), "utf-8");

		// Collect credential key names from the local environment
		const credentialKeys = this.collectCredentialKeys();

		// Upload the bundle as a GitHub Gist (avoids 3.8MB YAML issue)
		const gistUrl = await this.uploadBundleGist(tarPath, agentId);

		// Generate a small workflow YAML that downloads the bundle from the Gist
		const workflowYaml = this.generateWorkflowYaml(identity, prompt, credentialKeys, settings, gistUrl, request);

		// Deploy the workflow and trigger it
		// Multi-account: try config first, then provisioner pool, then gh CLI
		let token = this.config.token ?? process.env.GITHUB_TOKEN ?? this.getGhToken();
		let repo = this.config.repo;
		let leasedAccount: LeasedAccount | null = null;

		// If no token/repo in config, try leasing from provisioner pool
		if ((!token || !repo) && (await isProvisionerAlive())) {
			try {
				leasedAccount = await ensureAccount("github-actions");
				token = leasedAccount.apiKey;
				// The provisioner stores repo in metadata
				repo = (leasedAccount.metadata?.repo as string) || repo;
			} catch (err) {
				console.error(`[github-actions] Provisioner lease failed: ${err}`);
			}
		}

		if (!token) throw new Error("No GitHub token. Set GITHUB_TOKEN, run `gh auth login`, or start the provisioner.");
		if (!repo)
			throw new Error(
				"No repo configured. Run `prime-agent fleet runtimes install github-actions` or provision via the provisioner.",
			);

		// Check concurrency ceiling and queue if hit
		const queueLabel = this.config.queueLabel ?? process.env.RLM_QUEUE_LABEL ?? "rlm-task";
		let issueNumber: number | undefined;

		if (!this.config.noQueue && (await this.isCeilingHit(repo, token))) {
			console.log(`[github-actions] Concurrency ceiling hit, filing queued issue`);
			issueNumber = await this.fileQueuedIssue(repo, token, request, agentId);

			// Return a "queued" identity - the actual run will happen via queue-promoter
			const queuedIdentity: AgentIdentity = {
				...identity,
				label: `[QUEUED] ${identity.label}`,
			};

			// Create a status endpoint that checks for issue comments (promotion signal)
			const statusEndpoint: AgentStatusEndpoint = {
				poll: async () => {
					// Poll the issue for promotion status
					try {
						const issueResp = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
							headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
						});
						if (issueResp.ok) {
							const issue = (await issueResp.json()) as { state: string; comments: number };
							if (issue.state === "closed") {
								return { status: "running" as AgentStatus, durationMs: 0 };
							}
						}
					} catch {}
					return { status: "queued" as AgentStatus, durationMs: 0 };
				},
				subscribe: (listener) => {
					const interval = setInterval(async () => {
						const status = await statusEndpoint.poll?.();
						if (status && status.status !== "queued") {
							listener({ type: "status", status: status.status, info: status });
							clearInterval(interval);
						}
					}, 10000);
					return () => clearInterval(interval);
				},
				abort: async () => {
					// Close the issue to cancel the queued task
					if (issueNumber) {
						await this.closeQueuedIssue(repo, token, issueNumber, "", "cancelled");
					}
				},
				requestFile: async () => "",
				sendFile: async () => {
					throw new Error("Cannot send files to a queued task");
				},
			};

			return { identity: queuedIdentity, statusEndpoint };
		}

		// Set credentials as GitHub repository secrets (not embedded in YAML)
		await this.setRepositorySecrets(repo, token, credentialKeys);

		const workDir = request.workDir ?? `.rlm/sessions/fleet/${agentId}`;
		const runId = await this.triggerWorkflow(repo, token, workflowYaml, agentId, gistUrl, workDir, issueNumber);

		let currentStatus: AgentStatusInfo = { status: "running" };
		const eventListeners = new Set<(event: AgentEvent) => void>();

		// Start polling for status
		this.pollRunStatus(repo, token, runId, (status, info) => {
			currentStatus = info;
			for (const listener of eventListeners) {
				listener({ type: "status", status, info });
			}
		});

		const statusEndpoint: AgentStatusEndpoint = {
			poll: async () => currentStatus,
			subscribe: (listener) => {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
			abort: async () => {
				currentStatus = { ...currentStatus, status: "aborted", error: "Aborted by parent" };
				await this.cancelRun(repo, token, runId);
				if (leasedAccount) {
					await releaseAccount("github-actions", leasedAccount.email).catch(() => {});
					leasedAccount = null;
				}
				for (const listener of eventListeners) {
					listener({ type: "status", status: "aborted", info: currentStatus });
				}
			},
			requestFile: async (path) => {
				const artifacts = await this.downloadArtifacts(repo, token, runId);
				return artifacts[path] ?? "";
			},
			sendFile: async () => {
				// GH Actions doesn't support sending files to a running workflow
				throw new Error("Cannot send files to a running GitHub Actions workflow");
			},
		};

		return { identity, statusEndpoint };
	}

	/** Upload the bundle tarball as a secret Gist and return the raw URL. */
	private async uploadBundleGist(tarPath: string, agentId: string): Promise<string> {
		const tarBase64 = readFileSync(tarPath, "base64");
		const filename = `bundle-${agentId.slice(0, 8)}.tar.gz.b64`;
		const token = this.config.token ?? process.env.GITHUB_TOKEN ?? this.getGhToken();
		if (!token) throw new Error("No GitHub token for gist upload");

		const resp = await fetch("https://api.github.com/gists", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
			},
			body: JSON.stringify({
				description: `Prime Agent bundle ${agentId.slice(0, 8)}`,
				public: false,
				files: {
					[filename]: { content: tarBase64 },
				},
			}),
		});

		if (!resp.ok) {
			throw new Error(`Failed to upload gist: ${resp.status}`);
		}

		const data = (await resp.json()) as { files: Record<string, { raw_url: string }> };
		return data.files[filename].raw_url;
	}

	private generateWorkflowYaml(
		identity: AgentIdentity,
		_prompt: string,
		credentialKeys: string[],
		_settings: Record<string, unknown>,
		_gistUrl: string,
		_request: SpawnRequest,
	): string {
		const workDir = _request.workDir ?? `.rlm/sessions/fleet/${identity.agentId}`;
		const lines: string[] = [
			"name: Prime Agent",
			"on:",
			"  workflow_dispatch:",
			"    inputs:",
			"      agent_id:",
			"        description: 'Agent ID'",
			"        required: false",
			"      gist_url:",
			"        description: 'Bundle Gist URL'",
			"        required: false",
			"      work_dir:",
			"        description: 'Work directory relative to HOME'",
			"        required: false",
			`        default: '${workDir}'`,
			"      issue_number:",
			"        description: 'Linked issue number for closing after completion'",
			"        required: false",
			"  repository_dispatch:",
			"    types:",
			"      - rlm-promote",
			"",
			"jobs:",
			"  agent:",
			"    runs-on: ubuntu-latest",
			"    env:",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax
			"      AGENT_ID: ${{ github.event.inputs.agent_id || github.event.client_payload.issue_number || '' }}",
			"      INPUT_GIST_URL: ${{ github.event.inputs.gist_url || '' }}",
			"      INPUT_WORK_DIR: ${{ github.event.inputs.work_dir || '' }}",
			"      INPUT_ISSUE_NUMBER: ${{ github.event.inputs.issue_number || '' }}",
		];

		for (const k of credentialKeys) {
			lines.push(`      ${k}: ${{ secrets.${k} }}`);
		}

		lines.push(
			"    steps:",
			"      - name: Setup Node",
			"        uses: actions/setup-node@v4",
			"        with:",
			"          node-version: '22'",
			"",
			"      - name: Download and Extract Agent Bundle",
			"        run: |",
			"          GIST_URL="$INPUT_GIST_URL"",
			"          if [ -z "$GIST_URL" ]; then",
			"            echo "No gist URL provided"",
			"            exit 1",
			"          fi",
			"          curl -sL "$GIST_URL" -o /tmp/bundle.b64",
			"          base64 -d /tmp/bundle.b64 > /tmp/bundle.tar.gz",
			"          mkdir -p /tmp/agent-bundle",
			"          tar xzf /tmp/bundle.tar.gz -C /tmp/agent-bundle",
			"          BUNDLE_DIR=$(ls /tmp/agent-bundle)",
			'          echo "BUNDLE_DIR=/tmp/agent-bundle/$BUNDLE_DIR" >> $GITHUB_ENV',
			"          mkdir -p $BUNDLE_DIR/agent",
			`          BUNDLE_DIR=$BUNDLE_DIR node -e 'const fs=require("fs");const keys=${JSON.stringify(credentialKeys)};const env={};for(const k of keys){env[k]=process.env[k]||"";}fs.writeFileSync(process.env.BUNDLE_DIR+"/agent/env.json",JSON.stringify(env,null,2));'`,
			"",
			"      - name: Run Agent",
			"        run: |",
			"          bash $BUNDLE_DIR/run.sh",
			"        env:",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax
			"          AGENT_ID: ${{ github.event.inputs.agent_id || '' }}",
		);

		for (const k of credentialKeys) {
			lines.push(`          ${k}: ${{ secrets.${k} }}`);
		}

		lines.push(
			"",
			"      - name: Find Work Directory",
			"        if: always()",
			"        id: workdir",
			"        run: |",
			`          WORK_PATH="$HOME/${INPUT_WORK_DIR:-'${workDir}'}"`,
			'          echo "work_path=$WORK_PATH" >> $GITHUB_OUTPUT',
			"",
			"      - name: Upload Work Directory",
			"        if: always()",
			"        uses: actions/upload-artifact@v4",
			"        with:",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax
			"          name: agent-work-${{ github.run_id }}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax
			"          path: ${{ steps.workdir.outputs.work_path }}/",
			"          if-no-files-found: ignore",
			"",
			"      - name: Upload Agent Logs",
			"        if: always()",
			"        uses: actions/upload-artifact@v4",
			"        with:",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax
			"          name: agent-logs-${{ github.run_id }}",
			"          path: |",
			"            /tmp/agent-bundle/",
			"          if-no-files-found: ignore",
			"",
			"      - name: Close Linked Issue",
			"        if: env.INPUT_ISSUE_NUMBER != ''",
			"        run: |",
			"          gh issue comment "$INPUT_ISSUE_NUMBER" \",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions syntax
			"            --body "Run completed: [${{ github.run_id }}](<${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}>)"",
			"          gh issue close "$INPUT_ISSUE_NUMBER" --repo "${{ github.repository }}"",
		);

		return `${lines.join("\n")}\n`;
	}

	private getGhToken(): string | undefined {
		try {
			return execSync("gh auth token", { encoding: "utf-8" }).trim() || undefined;
		} catch {
			return undefined;
		}
	}

	/** Collect API key names from the local environment — values are NOT embedded. */
	private collectCredentialKeys(): string[] {
		const keyPatterns = [/.*_API_KEY$/, /.*_TOKEN$/, /.*_SECRET$/, /.*_OAUTH_TOKEN$/];
		return Object.keys(process.env)
			.filter((k) => keyPatterns.some((p) => p.test(k)) && process.env[k])
			.slice(0, 20); // Limit to avoid hitting GitHub secret limits
	}

	/** Set credentials as GitHub repository secrets using gh CLI. */
	private async setRepositorySecrets(repo: string, _token: string, keys: string[]): Promise<void> {
		const token = this.config.token ?? process.env.GITHUB_TOKEN ?? this.getGhToken();
		for (const keyName of keys) {
			const value = process.env[keyName];
			if (!value) continue;
			try {
				execSync(`gh secret set ${keyName} --repo ${repo}`, {
					input: value,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
				});
			} catch (err) {
				console.error(`Failed to set secret ${keyName}:`, err);
			}
		}
	}

	// detectRepo() removed — GitHub Actions runtime now requires a dedicated
	// repo configured via setup(). No more cwd repo fallback.


	/**
	 * Check how many workflow runs are currently active (queued or in_progress).
	 */
	private async countActiveRuns(repo: string, token: string): Promise<number> {
		try {
			const resp = await fetch(
				`https://api.github.com/repos/${repo}/actions/runs?status=in_progress&per_page=100`,
				{ headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
			);
			if (!resp.ok) return 0;
			const inProgress = ((await resp.json()) as { total_count: number }).total_count;

			const queuedResp = await fetch(
				`https://api.github.com/repos/${repo}/actions/runs?status=queued&per_page=100`,
				{ headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
			);
			const queued = queuedResp.ok ? ((await queuedResp.json()) as { total_count: number }).total_count : 0;

			return inProgress + queued;
		} catch {
			return 0;
		}
	}

	/**
	 * Check if the concurrency ceiling has been reached.
	 */
	private async isCeilingHit(repo: string, token: string): Promise<boolean> {
		const maxConcurrent = this.config.maxConcurrent ?? parseInt(process.env.RLM_MAX_CONCURRENT ?? "10", 10);
		const activeRuns = await this.countActiveRuns(repo, token);
		return activeRuns >= maxConcurrent;
	}

	/**
	 * File a GitHub Issue for a queued task.
	 * Returns the issue number.
	 */
	private async fileQueuedIssue(
		repo: string,
		token: string,
		request: SpawnRequest,
		agentId: string,
	): Promise<number> {
		const queueLabel = this.config.queueLabel ?? process.env.RLM_QUEUE_LABEL ?? "rlm-task";
		const workDir = request.workDir ?? `.rlm/sessions/fleet/${agentId}`;

		// Format the issue body with spawn parameters
		const issueBody = `<!-- rlm-queued: true -->
```
rlm-queued: true
spawn-params:
  prompt: |
    ${request.prompt.replace(/"/g, '\"').replace(/\n/g, '\n')}
  model: ${request.model ?? "default"}
  name: ${request.name ?? ""}
  depth: ${request.depth}
  parent-agent-id: ${request.parent?.agentId ?? ""}
  work-dir: ${workDir}
  agent-id: ${agentId}

queued-at: ${new Date().toISOString()}
```

<!-- Add comments to this issue to track promotion status. -->
`;

		const title = `[RLM Task] ${request.name ?? request.prompt.slice(0, 80)}`;

		const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				title,
				body: issueBody,
				labels: [queueLabel],
			}),
		});

		if (!resp.ok) {
			const errText = await resp.text();
			throw new Error(`Failed to file queued issue: ${resp.status} ${errText}`);
		}

		const data = (await resp.json()) as { number: number };
		console.log(`[github-actions] Filed queued issue #${data.number}`);
		return data.number;
	}

	/**
	 * Close a queued issue and add a comment linking to the run.
	 */
	private async closeQueuedIssue(repo: string, token: string, issueNumber: number, runUrl: string, conclusion?: string): Promise<void> {
		try {
			// Add comment with run link
			await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					body: conclusion
						? `Run completed: [${conclusion}](<${runUrl}>)`
						: `Run completed: [${runUrl}>](<${runUrl}>)`,
				}),
			});

			// Close the issue
			await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ state: "closed", state_reason: "completed" }),
			});

			console.log(`[github-actions] Closed issue #${issueNumber}, run: ${runUrl}`);
		} catch (err) {
			console.error(`[github-actions] Failed to close issue #${issueNumber}:`, err);
		}
	}

	/**
	 * Trigger a workflow for a promoted issue.
	 * Reads spawn params from the issue body.
	 */
	private async triggerWorkflowForIssue(
		repo: string,
		token: string,
		issueNumber: number,
		workflowFile: string,
		gistUrl: string,
	): Promise<number> {
		// Get the issue to extract spawn params
		const issueResp = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
		});

		if (!issueResp.ok) {
			throw new Error(`Failed to fetch issue #${issueNumber}: ${issueResp.status}`);
		}

		const issue = (await issueResp.json()) as { body: string; title: string };
		const runId = await this.triggerWorkflow(repo, token, "", "", gistUrl, "");

		return runId;
	}
	private async triggerWorkflow(
		repo: string,
		token: string,
		workflowYaml: string,
		agentId: string,
		gistUrl: string,
		workDir: string,
		issueNumber?: number,
	): Promise<number> {
		const workflowFile = ".github/workflows/prime-agent.yml";

		// Get the default branch
		const repoResp = await fetch(`https://api.github.com/repos/${repo}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
		});
		const repoData = (await repoResp.json()) as { default_branch: string };
		const defaultBranch = repoData.default_branch;

		// Check if the workflow file already exists
		const checkResp = await fetch(
			`https://api.github.com/repos/${repo}/contents/${workflowFile}?ref=${defaultBranch}`,
			{ headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
		);
		const existingSha = checkResp.ok ? ((await checkResp.json()) as { sha?: string }).sha : undefined;

		// Create or update the workflow file
		const fileResp = await fetch(`https://api.github.com/repos/${repo}/contents/${workflowFile}`, {
			method: "PUT",
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
			body: JSON.stringify({
				message: `Update prime-agent workflow`,
				content: Buffer.from(workflowYaml).toString("base64"),
				branch: defaultBranch,
				...(existingSha ? { sha: existingSha } : {}),
			}),
		});
		if (!fileResp.ok) {
			const errText = await fileResp.text();
			throw new Error(`Failed to create workflow file: ${fileResp.status} ${errText}`);
		}

		// Trigger with retries — GitHub may need time to index a new workflow file
		const triggerUrl = `https://api.github.com/repos/${repo}/actions/workflows/prime-agent.yml/dispatches`;
		const triggerBody = JSON.stringify({
			ref: defaultBranch,
			inputs: { agent_id: agentId, gist_url: gistUrl, work_dir: workDir, issue_number: issueNumber?.toString() ?? '' },
		});
		const triggerHeaders = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };

		let triggered = false;
		for (let attempt = 0; attempt < 12; attempt++) {
			await new Promise((r) => setTimeout(r, 10000));
			const triggerResp = await fetch(triggerUrl, {
				method: "POST",
				headers: triggerHeaders,
				body: triggerBody,
			});
			if (triggerResp.ok) {
				triggered = true;
				break;
			}
			if (triggerResp.status !== 404 && triggerResp.status !== 422) {
				const errText = await triggerResp.text();
				throw new Error(`Failed to trigger workflow: ${triggerResp.status} ${errText}`);
			}
		}
		if (!triggered) {
			throw new Error("Failed to trigger workflow after 12 retries (workflow not indexed)");
		}

		// Poll for the run ID
		await new Promise((r) => setTimeout(r, 5000));
		const runsResp = await fetch(
			`https://api.github.com/repos/${repo}/actions/workflows/prime-agent.yml/runs?per_page=1`,
			{ headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
		);
		const runsData = (await runsResp.json()) as { workflow_runs: Array<{ id: number; created_at: string }> };
		return runsData.workflow_runs[0]?.id ?? 0;
	}

	private async pollRunStatus(
		repo: string,
		token: string,
		runId: number,
		callback: (status: AgentStatus, info: AgentStatusInfo) => void,
	): Promise<void> {
		const startTime = Date.now();
		const poll = async () => {
			if (!runId) return;
			try {
				const resp = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}`, {
					headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
				});
				if (!resp.ok) return;
				const data = (await resp.json()) as {
					status: string;
					conclusion: string | null;
					created_at: string;
				};

				const statusMap: Record<string, AgentStatus> = {
					queued: "running",
					in_progress: "running",
					completed: data.conclusion === "success" ? "completed" : "error",
				};
				const status = statusMap[data.status] ?? "running";
				const info: AgentStatusInfo = {
					status,
					durationMs: Date.now() - startTime,
					error: data.conclusion && data.conclusion !== "success" ? `Workflow ${data.conclusion}` : undefined,
				};
				callback(status, info);

				if (data.status !== "completed") {
					setTimeout(poll, 5000);
				}
			} catch {}
		};
		setTimeout(poll, 3000);
	}

	private async cancelRun(repo: string, token: string, runId: number): Promise<void> {
		if (!runId) return;
		try {
			await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/cancel`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
			});
		} catch {}
	}

	private async downloadArtifacts(repo: string, token: string, runId: number): Promise<Record<string, string>> {
		if (!runId) return {};
		try {
			const resp = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`, {
				headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
			});
			const data = (await resp.json()) as { artifacts: Array<{ name: string; archive_download_url: string }> };
			const files: Record<string, string> = {};
			for (const artifact of data.artifacts) {
				const dlResp = await fetch(artifact.archive_download_url, {
					headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
				});
				if (!dlResp.ok) continue;
				const zipBuffer = Buffer.from(await dlResp.arrayBuffer());
				const extracted = await this.extractZipFiles(zipBuffer);
				Object.assign(files, extracted);
			}
			return files;
		} catch {
			return {};
		}
	}

	private async extractZipFiles(zipBuffer: Buffer): Promise<Record<string, string>> {
		const { spawn } = await import("node:child_process");
		const tmpDir = `/tmp/agent-artifacts-${Date.now()}`;
		const zipPath = `${tmpDir}.zip`;
		writeFileSync(zipPath, zipBuffer);
		mkdirSync(tmpDir, { recursive: true });

		await new Promise<void>((resolve, reject) => {
			const unzip = spawn("unzip", ["-o", zipPath, "-d", tmpDir], { stdio: ["pipe", "pipe", "pipe"] });
			unzip.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))));
			unzip.on("error", reject);
		});

		const files: Record<string, string> = {};
		const collectFiles = (dir: string, base = "") => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const fullPath = join(dir, entry.name);
				const relPath = base ? `${base}/${entry.name}` : entry.name;
				if (entry.isDirectory()) {
					collectFiles(fullPath, relPath);
				} else {
					try {
						files[relPath] = readFileSync(fullPath, "utf-8");
					} catch {}
				}
			}
		};
		try {
			collectFiles(tmpDir);
		} catch {}

		return files;
	}
}

// ─── Plugin setup (interactive) ────────────────────────────────────

/**
 * Interactive setup for the GitHub Actions runtime.
 *
 * Flow:
 * 1. Check `gh auth status` — if not logged in, prompt user to run `gh auth login`
 * 2. Check for a dedicated repo in config — if missing, offer to create one or use existing
 * 3. Create a private repo (default: `prime-agent-runs`) if user chooses
 * 4. Save repo + token to config
 *
 * This is called when the user enables/installs the plugin from the fleet menu.
 * It does NOT use the current working directory's repo — agents need a dedicated
 * private repo to avoid polluting other repos' config and workflow history.
 */
export async function setupGitHubActions(
	config: Record<string, unknown>,
	prompt: {
		ask: (q: string, def?: string) => Promise<string | undefined>;
		confirm: (q: string, def?: boolean) => Promise<boolean>;
		choose: (q: string, options: string[]) => Promise<number>;
		status: (msg: string) => void;
	},
): Promise<{ success: boolean; message: string; config?: Record<string, unknown> }> {
	const newConfig = { ...config };

	// 1. Check gh auth
	prompt.status("Checking GitHub authentication...");
	let authed = false;
	try {
		const output = execSync("gh auth status 2>&1", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		// gh auth status may exit non-zero if one account is invalid,
		// but as long as one account is active, we're authed
		authed = output.includes("✓ Logged in") && output.includes("Active account: true");
	} catch (err) {
		// Check stdout even on failure — gh may exit 1 with valid auth
		const output = (err as { stdout?: string }).stdout ?? "";
		authed = output.includes("✓ Logged in") && output.includes("Active account: true");
	}

	if (!authed) {
		prompt.status("Not logged in to GitHub. Please run: gh auth login");
		const confirmed = await prompt.confirm("Open GitHub login in browser? (runs: gh auth login --web)", true);
		if (confirmed) {
			prompt.status("Running: gh auth login --web (follow prompts in terminal)...");
			try {
				// Use spawn (async) so the event loop isn't blocked and
				// interactive prompts from gh auth login work properly
				await new Promise<void>((resolve, reject) => {
					const child = spawn("gh", ["auth", "login", "--web"], {
						stdio: "inherit",
						env: { ...process.env },
					});
					child.on("error", reject);
					child.on("exit", (code) => {
						if (code === 0) resolve();
						else reject(new Error(`gh auth login exited with code ${code}`));
					});
				});
				authed = true;
			} catch (err) {
				return {
					success: false,
					message: `GitHub login failed: ${err instanceof Error ? err.message : String(err)}. Run \`gh auth login\` manually and retry.`,
				};
			}
		} else {
			return {
				success: false,
				message: "GitHub login required. Run `gh auth login` and retry.",
			};
		}
	}

	// 2. Get token
	let token: string | undefined;
	try {
		token = execSync("gh auth token", { encoding: "utf-8" }).trim();
	} catch {}

	if (!token) {
		return { success: false, message: "Could not get GitHub token. Run `gh auth login`." };
	}

	// 3. Fetch user's repos and show the picker (always — even if reconfiguring)
	const existingRepo = newConfig.repo as string | undefined;
	let userRepos: { name: string; visibility: string; permission: string }[] = [];
	try {
		prompt.status("Fetching your GitHub repos...");
		const reposJson = execSync(
			'gh repo list --limit 30 --json nameWithOwner,visibility,viewerPermission --jq \'.[] | .nameWithOwner + "," + .visibility + "," + .viewerPermission\'',
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		userRepos = reposJson
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [name, visibility, permission] = line.split(",");
				return { name, visibility, permission };
			})
			.filter((r) => r.permission === "ADMIN" || r.permission === "WRITE" || r.permission === "MAINTAIN");
	} catch {
		// gh repo list failed — fall back to manual entry
	}

	const options = [
		"Create a new public repo (unlimited Actions compute)",
		"Create a new private repo (limited but hidden)",
	];
	const repoOffset = options.length;
	for (const r of userRepos) {
		const isCurrent = r.name === existingRepo;
		options.push(`Use existing: ${r.name} (${r.visibility})${isCurrent ? " — current" : ""}`);
	}
	options.push("Use an existing repo (enter name manually)");

	const choice = await prompt.choose(
		existingRepo
			? `GitHub Actions repo (currently: ${existingRepo}). Pick or create a new one:`
			: "GitHub Actions needs a dedicated repo for agent runs. What do you want to do?",
		options,
	);

	if (choice === 0 || choice === 1) {
		// Create new repo
		const isPublic = choice === 0;
		const defaultName = "prime-agent-runs";
		const repoName = await prompt.ask("Repo name:", defaultName);
		if (!repoName) {
			return { success: false, message: "Setup cancelled" };
		}

		// Get username
		let username: string | undefined;
		try {
			username = execSync("gh api user --jq .login", { encoding: "utf-8" }).trim();
		} catch {
			return { success: false, message: "Could not get GitHub username. Run `gh auth login`." };
		}

		const fullRepo = `${username}/${repoName}`;
		const visibilityFlag = isPublic ? "--public" : "--private";
		prompt.status(`Creating ${isPublic ? "public" : "private"} repo ${fullRepo}...`);

		try {
			execSync(`gh repo create ${repoName} ${visibilityFlag} --description "Prime Agent runtime runs"`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			// Repo might already exist
			const exists = await prompt.confirm(
				`Could not create repo (may already exist). Use ${fullRepo} anyway?`,
				true,
			);
			if (!exists) {
				return { success: false, message: `Repo creation failed: ${err}` };
			}
		}

		newConfig.repo = fullRepo;
		newConfig.token = token;
		return {
			success: true,
			message: `Created ${isPublic ? "public" : "private"} repo ${fullRepo} for GitHub Actions runs`,
			config: newConfig,
		};
	} else if (choice >= repoOffset && choice < repoOffset + userRepos.length) {
		// Picked from the user's repo list
		const pickedRepo = userRepos[choice - repoOffset];
		const repoInput = pickedRepo.name;

		// Verify access (re-check even though we filtered)
		prompt.status(`Checking repo ${repoInput}...`);
		try {
			const resp = execSync(`gh repo view ${repoInput} --json name,visibility,viewerPermission`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const info = JSON.parse(resp) as { visibility: string; viewerPermission: string };
			if (info.viewerPermission === "READ" || info.viewerPermission === "TRIAGE") {
				return {
					success: false,
					message: `No write access to ${repoInput}. Choose a repo you own or have admin access to.`,
				};
			}
			if (info.visibility === "PUBLIC") {
				const confirmPublic = await prompt.confirm(
					`${repoInput} is public. Public repos have unlimited Actions runs but anyone can see workflow files. Continue?`,
					false,
				);
				if (!confirmPublic) {
					return { success: false, message: "Setup cancelled" };
				}
			}
		} catch {
			return { success: false, message: `Could not access repo ${repoInput}. Check the name and your access.` };
		}

		newConfig.repo = repoInput;
		newConfig.token = token;
		return {
			success: true,
			message: `GitHub Actions runtime configured with repo: ${repoInput} (${pickedRepo.visibility})`,
			config: newConfig,
		};
	} else {
		// Manual entry (last option)
		const repoInput = await prompt.ask("Enter repo (owner/name):");
		if (!repoInput) {
			return { success: false, message: "Setup cancelled" };
		}

		// Verify access
		prompt.status(`Checking repo ${repoInput}...`);
		try {
			const resp = execSync(`gh repo view ${repoInput} --json name,visibility,viewerPermission`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const info = JSON.parse(resp) as { visibility: string; viewerPermission: string };
			if (info.viewerPermission === "READ" || info.viewerPermission === "TRIAGE") {
				return {
					success: false,
					message: `No write access to ${repoInput}. Choose a repo you own or have admin access to.`,
				};
			}
			if (info.visibility === "PUBLIC") {
				const confirmPublic = await prompt.confirm(
					`${repoInput} is public. Public repos have unlimited Actions runs but anyone can see workflow files. Continue?`,
					false,
				);
				if (!confirmPublic) {
					return { success: false, message: "Setup cancelled" };
				}
			}
		} catch {
			return { success: false, message: `Could not access repo ${repoInput}. Check the name and your access.` };
		}

		newConfig.repo = repoInput;
		newConfig.token = token;
		return {
			success: true,
			message: `GitHub Actions runtime configured with repo: ${repoInput}`,
			config: newConfig,
		};
	}
}
