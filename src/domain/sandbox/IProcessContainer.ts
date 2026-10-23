/**
 * Process-container port for agent shell commands.
 * Layer: Domain. The host implementation is MXC containment "process"
 * (AppContainer/BaseContainer on Windows, bubblewrap on Linux, Seatbelt on macOS).
 */
export interface ProcessContainerRequest {
  readonly command: string;
  readonly workspaceRoot: string;
  readonly timeoutMs: number;
}

export interface ProcessContainerResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export interface IProcessContainer {
  isAvailable(): Promise<boolean>;
  run(request: ProcessContainerRequest): Promise<ProcessContainerResult>;
}
