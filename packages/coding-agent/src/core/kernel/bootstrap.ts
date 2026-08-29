/**
 * Kernel bootstrap — no-op stub.
 * The JS code tool (vm.Context) doesn't need Python kernel bootstrapping.
 */

export type KernelBootstrapProgressHandler = (message: string) => void;

export async function ensureKernelPython(): Promise<void> {
	// No-op — JS code tool doesn't need Python.
}

export const DEFAULT_RLM_EXTRA_IMPORT_LABELS: string[] = [];
