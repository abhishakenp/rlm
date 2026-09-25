// Type declarations for eleksha-connection.js
declare module 'eleksha-connection' {
  export interface ElekshaConnectionOptions {
    endpoint?: string;
    timeout?: number;
    retries?: number;
  }

  export class ElekshaConnection {
    constructor();
    connect(socketPath?: string): Promise<boolean>;
    isConnected(): boolean;
    disconnect(): void;
    send(data: string): boolean;
  }

  export default ElekshaConnection;
}

// Also declare the absolute path variant
declare module '/Users/abhi/proj/rlm/eleksha-connection.js' {
  export interface ElekshaConnectionOptions {
    endpoint?: string;
    timeout?: number;
    retries?: number;
  }

  export class ElekshaConnection {
    constructor();
    connect(socketPath?: string): Promise<boolean>;
    isConnected(): boolean;
    disconnect(): void;
    send(data: string): boolean;
  }

  export default ElekshaConnection;
}
