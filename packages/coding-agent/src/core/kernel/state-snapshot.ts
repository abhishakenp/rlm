/**
 * State snapshot — minimal stub.
 * The JS code tool (vm.Context) doesn't use on-disk snapshots.
 * These types remain for compatibility with agent-session.ts.
 */

export interface RestoreResult {
	restored: string[];
	failed: string[];
	path: string;
}

export function snapshotPathIn(dir: string): string {
	return `${dir}/code-snapshot.json`;
}

export function manifestPathIn(dir: string): string {
	return `${dir}/code-manifest.json`;
}
