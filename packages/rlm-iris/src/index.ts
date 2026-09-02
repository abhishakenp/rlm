import { Service } from "@deepseek-ai/cordis"; 

export class RlmIris extends Service {
  static provide() {
    return {
      // The command will be exposed as `rlm iris`
      iris: async () => {
        // Run the iris-converse command as specified
        const cmd = "iris-converse --resume ~/.iris/mind/sessions/iris.jsonl --session-dir ~/.iris/mind/sessions"; 
        // Execute the command and return its output
        const result = await this.ctx.run(cmd); 
        // Return the output for the user to see
        return { output: result.stdout, exitCode: result.exitCode }; 
      },
    };
  }
}
