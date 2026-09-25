'use strict';
const { createConnection } = require("node:net");
const { existsSync } = require("node:fs");

const ELEKSHA_HTTP_ENDPOINT = "http://localhost:9222";
const ELEKSHA_WS_ENDPOINT = "ws://localhost:9222";
const ELEKSHA_UDS_PATH = "/tmp/lightbol.sock";
const CONNECT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

class ElekshaConnection {
    constructor() {
        this.socket = null;
        this.connected = false;
    }

    async connect(socketPath = ELEKSHA_UDS_PATH) {
        if (this.connected) {
            return true;
        }
        if (!existsSync(socketPath)) {
            throw new Error(`Eleksha socket not found: ${socketPath}`);
        }
        return new Promise((resolve, reject) => {
            this.socket = createConnection(socketPath, () => {
                this.connected = true;
                resolve(true);
            });
            this.socket.on("error", (err) => {
                this.connected = false;
                reject(err);
            });
            this.socket.on("close", () => {
                this.connected = false;
            });
        });
    }

    isConnected() {
        return this.connected && this.socket !== null && !this.socket.destroyed;
    }

    disconnect() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
            this.connected = false;
        }
    }

    send(data) {
        if (!this.isConnected()) {
            return false;
        }
        this.socket.write(data);
        return true;
    }
}

module.exports = ElekshaConnection;
