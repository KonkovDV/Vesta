/**
 * Python Skill Bridge Port
 *
 * Domain-layer contract for Python skill execution.
 * Infrastructure provides the implementation via DI.
 */

/**
 * Result of Python skill execution
 */
export interface PythonSkillResult<TData = unknown> {
  success: boolean;
  output: string;
  error?: string;
  data?: TData;
}

/**
 * Options for Python skill execution
 */
export interface PythonSkillOptions {
  skillName: string;
  scriptPath: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * Port for executing Python skills.
 * Implemented by Infrastructure layer (PythonSkillBridge).
 */
export interface IPythonSkillBridge {
  /**
   * Execute a Python skill with given options
   */
  execute<TData = unknown>(options: PythonSkillOptions): Promise<PythonSkillResult<TData>>;
}

/**
 * DI token for PythonSkillBridge
 */
export const PYTHON_SKILL_BRIDGE_TOKEN = 'IPythonSkillBridge' as const;
