/**
 * An unreachable model endpoint is not a failed request.
 *
 * The local gateway (OmniRoute on :20128) restarts: a launchd kickstart, a
 * deploy, a crash that KeepAlive brings back. Each restart used to cost every
 * running agent its run — the ordinary retry budget is three attempts at 2s,
 * 4s and 8s, so a run gave up fourteen seconds into an outage that lasted a
 * minute. On 2026-09-25, 265 of the 273 errors in rlm sessions were exactly
 * this, and 7 of the 17 affected sessions ended on the error with nobody
 * resuming them.
 *
 * So connectivity failures get their own policy: keep retrying with capped
 * exponential backoff for as long as the endpoint could plausibly be coming
 * back (the patience window), and only then give up. Everything else keeps the
 * attempt-count budget it always had.
 */

const OUTAGE_PATTERNS: RegExp[] = [
	/\bconnection error\b/i,
	/socket connection was closed/i,
	/\bsocket hang up\b/i,
	/\bother side closed\b/i,
	/\bECONNREFUSED\b/,
	/\bECONNRESET\b/,
	/\bECONNABORTED\b/,
	/\bEHOSTUNREACH\b/,
	/\bENETUNREACH\b/,
	/\bENOTFOUND\b/,
	/\bEPIPE\b/,
	/\bUND_ERR_SOCKET\b/,
	/\bfetch failed\b/i,
	/\bunable to connect\b/i,
	/\bnetwork error\b/i,
	/\bnetwork connection lost\b/i,
	/\b(502|503|504)\b.*\b(bad gateway|service unavailable|gateway time-?out)\b/i,
	/\b(bad gateway|service unavailable|gateway time-?out)\b/i,
];

/** True when the error says the endpoint could not be reached, not that it refused the request. */
export const isEndpointOutageError = (errorMessage: string | undefined): boolean =>
	!!errorMessage && OUTAGE_PATTERNS.some((pattern) => pattern.test(errorMessage));

export interface OutageRetryPolicy {
	/** First delay; doubles each attempt. */
	baseDelayMs: number;
	/** Ceiling for a single delay. */
	maxBackoffMs: number;
	/** How long after the first failure to keep trying. */
	patienceMs: number;
}

export const DEFAULT_OUTAGE_PATIENCE_MS = 10 * 60_000;
export const DEFAULT_OUTAGE_MAX_BACKOFF_MS = 30_000;

/** Delay before attempt `attempt` (1-based): base·2^(n-1), capped. */
export const outageDelayMs = (attempt: number, policy: Pick<OutageRetryPolicy, "baseDelayMs" | "maxBackoffMs">): number =>
	Math.min(policy.maxBackoffMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));

/**
 * Whether to keep waiting for the endpoint. The next attempt is allowed when
 * it would start inside the patience window, so a policy never sleeps past it.
 */
export const shouldKeepWaitingForEndpoint = (
	outageStartedAt: number,
	now: number,
	nextDelayMs: number,
	policy: Pick<OutageRetryPolicy, "patienceMs">,
): boolean => now - outageStartedAt + nextDelayMs <= policy.patienceMs;
