/**
 * Eleksha (lightbol/Lightpanda) connection module.
 *
 * Eleksha is the session name for the Lightpanda headless browser, which
 * communicates over:
 *   - HTTP: http://localhost:9222
 *   - Unix Domain Socket: /tmp/lightbol.sock
 */
import { createConnection, type Socket } from "node:net";
import { existsSync } from "node:fs";

export const ELEKSHA_HTTP_ENDPOINT = "http://localhost:9222";
export const ELEKSHA_WS_ENDPOINT = "ws://localhost:9222";
export const ELEKSHA_UDS_PATH = "/tmp/lightbol.sock";
export const ELEKSHA_CONNECT_TIMEOUT_MS = 30000;

export interface ElekshaConnectionOptions {
	/** Path to the Unix Domain Socket (default: /tmp/lightbol.sock) */
	socketPath?: string;
	/** Connection timeout in ms (default: 30000) */
	timeout?: number;
}

export interface ElekshaSession {
	/** Active socket connection to Eleksha */
	socket: Socket;
	/** Session identifier */
	id: string;
}

/**
 * Connect to Eleksha (lightbol/Lightpanda) via Unix Domain Socket.
 *
 * @example
 * const session = await connectToEleksha();
 * if (session) {
 *   // Connected, use session.socket for communication
 * }
 */
export async function connectToEleksha(
	options: ElekshaConnectionOptions = {},
): Promise<ElekshaSession | null> {
	const socketPath = options.socketPath ?? ELEKSHA_UDS_PATH;

	// Verify socket exists before attempting connect
	if (!existsSync(socketPath)) {
		return null;
	}

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Eleksha connection timed out after ${options.timeout ?? ELEKSHA_CONNECT_TIMEOUT_MS}ms`));
		}, options.timeout ?? ELEKSHA_CONNECT_TIMEOUT_MS);

		const socket = createConnection(socketPath, () => {
			clearTimeout(timeout);
			resolve({
				socket,
				id: `eleksha-${Date.now()}`,
			});
		});

		socket.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});

		socket.on("close", () => {
			// Connection closed
		});
	});
}

/**
 * Check if Eleksha socket is reachable.
 */
export async function canConnectToEleksha(socketPath: string = ELEKSHA_UDS_PATH): Promise<boolean> {
	if (!existsSync(socketPath)) {
		return false;
	}
	try {
		const session = await connectToEleksha({ socketPath, timeout: 1000 });
		if (session) {
			session.socket.destroy();
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Send a command to Eleksha over the active connection.
 */
export function sendToEleksha(session: ElekshaSession, command: string): boolean {
	if (session.socket.destroyed) {
		return false;
	}
	session.socket.write(command + "\n");
	return true;
}

/**
 * Disconnect from Eleksha gracefully.
 */
export function disconnectFromEleksha(session: ElekshaSession): void {
	if (!session.socket.destroyed) {
		session.socket.destroy();
	}
}
