// iris-ok provides a simple verification command that responds with 'ok'
import { Service } from "@deepseek-ai/cordis";

// This plugin exists to provide a minimal iris command that verifies connectivity

export class IrisOk extends Service {
  static provide = "irisOk" as const;

  constructor(goog: any) {
    super(goog, undefined as any);
  }

  async hello(): Promise<string> {
    return "ok";
  }
}

// Export both the class and a simple hello function for the check
export async function hello(): Promise<string> {
  return "ok";
}
export default IrisOk;
