# RlmDelegateService Public Methods

## intake
Signature: intake(request: string, options?: { source?: string; taskId?: string }): { graph: Graph; taskId: string } | null

## declare
Signature: declare(goal: string, tasks: TaskInput[], graphId?: string): Graph

## refine
Signature: refine(graphId: string, taskId: string, tasks: TaskInput[]): Graph

## run
Signature: run(graphId: string, runner?: Runner, options?: RunOptions): Promise<Graph>

## drive
Signature: drive(options?: Partial<DriveOptions>): Promise<DriveReport>
