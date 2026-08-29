/**
 * Boot gate — no-op stub.
 * The JS code tool (vm.Context) doesn't need boot gating.
 */
export async function withKernelBootPermit<T>(fn: () => Promise<T>, _signal?: AbortSignal): Promise<T> {
	return fn();
}
