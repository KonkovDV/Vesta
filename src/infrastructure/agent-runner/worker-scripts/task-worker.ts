/**
 * Task Worker Script
 * Runs inside Worker Thread to execute tasks
 * Layer: Infrastructure/Worker
 */

import { parentPort, workerData, MessagePort } from 'worker_threads';
import { ISandboxedExecutor } from '../../../domain/sandbox/sandboxed-executor.port';
import { IdGenerator } from '../../../core/utils/IdGenerator';

/**
 * Worker data received from main thread
 */
interface WorkerData {
  workerId: string;
  resourceLimits: {
    maxMemoryMb: number;
    maxCpuPercent: number;
  };
}

import { CallToolMessage, ToolResultMessage } from '../../../domain/agents/tools.interface';

// Map to store pending RPC promises: correlationId -> { resolve, reject }
const pendingToolCalls = new Map<string, { resolve: (val: unknown) => void; reject: (err: unknown) => void }>();

/**
 * Task execution message
 */
interface ExecuteMessage {
  type: 'EXECUTE';
  taskId: string;
  payload: TaskPayload;
  timeoutMs: number;
  resourceLimits: {
    maxMemoryMb: number;
    maxCpuPercent: number;
  };
}

/**
 * Shutdown message
 */
interface ShutdownMessage {
  type: 'SHUTDOWN';
}

/**
 * Task payload types
 */
interface TaskPayload {
  type: 'sandbox' | 'javascript' | 'function';
  code?: string;
  language?: 'javascript' | 'python';
  functionName?: string;
  args?: unknown[];
  timeoutMs?: number;
  memoryLimitMb?: number;
}

/**
 * Worker response
 */
interface WorkerResponse {
  type: 'COMPLETE' | 'ERROR' | 'PROGRESS';
  taskId: string;
  payload?: unknown;
  error?: {
    message: string;
    code: string;
    stack?: string;
  };
  progress?: {
    percent: number;
    message?: string;
  };
}

// Worker state
let isShuttingDown = false;
let currentTaskTimeout: NodeJS.Timeout | null = null;
const data = workerData as WorkerData;

/**
 * Main message handler
 */
function handleMessage(port: MessagePort, message: ExecuteMessage | ShutdownMessage): void {
  if (isShuttingDown) {
    return;
  }

  switch (message.type) {
    case 'EXECUTE':
      handleExecute(port, message)
        .catch((err) => {
          port.postMessage({
            type: 'ERROR',
            taskId: (message).taskId,
            error: { message: String(err), code: 'UNHANDLED_EXECUTE_ERROR' },
          });
        });
      break;
    case 'SHUTDOWN':
      handleShutdown(port);
      break;
  }
}

/**
 * Handle execute message
 */
async function handleExecute(port: MessagePort, message: ExecuteMessage): Promise<void> {
  const { taskId, payload, timeoutMs } = message;

  // Set up timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    currentTaskTimeout = setTimeout(() => {
      reject(new Error(`Task timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    // Report progress
    sendProgress(port, taskId, 10, 'Starting execution');

    // Execute the task (KI-006: single cleanup in finally)
    const result = await Promise.race([
      executeTask(payload),
      timeoutPromise,
    ]);

    // Send completion
    sendComplete(port, taskId, result);
  } catch (error) {
    // Send error
    sendError(port, taskId, error as Error);
  } finally {
    // KI-006: Clear timeout in finally — prevents timer leak on either success or error
    if (currentTaskTimeout) {
      clearTimeout(currentTaskTimeout);
      currentTaskTimeout = null;
    }
  }
}

/**
 * Execute task based on type
 */
async function executeTask(payload: TaskPayload): Promise<unknown> {
  switch (payload.type) {
    case 'javascript':
      return executeJavaScript(payload);
    case 'function':
      return executeFunction(payload);
    case 'sandbox':
      return executeSandbox(payload);
    default:
      throw new Error('Unknown task type');
  }
}

/**
 * Execute JavaScript code
 */
async function executeJavaScript(payload: TaskPayload): Promise<unknown> {
  if (!payload.code) {
    throw new Error('Code is required for javascript task type');
  }

  // Create a safe context for execution
  const context = {
    console: {
      log: (...args: unknown[]) => {
        // Log to parent thread if needed
        parentPort?.postMessage({ type: 'LOG', args });
      },
      error: (...args: unknown[]) => {
        parentPort?.postMessage({ type: 'ERROR_LOG', args });
      },
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
    Date,
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    useTool: (name: string, args: unknown) => useTool(name, args),
  };

  // Execute in isolated context
  const fn = new Function(
    'context',
    `
      with (context) {
        return (async () => {
          ${payload.code}
        })();
      }
    `,
  );

  return fn(context);
}

/**
 * Execute a named function
 */
async function executeFunction(payload: TaskPayload): Promise<unknown> {
  const fn = functionRegistry.get(payload.functionName || '');
  if (!fn) {
    throw new Error('Function not found: ' + (payload.functionName ?? '<unknown>'));
  }

  return fn(...(payload.args || []));
}

/**
 * Execute sandbox task (placeholder - would integrate with ISandboxedExecutor)
 */
async function executeSandbox(payload: TaskPayload): Promise<unknown> {
  // This would integrate with the sandbox executor from Phase 1
  // For now, delegate to JavaScript execution
  return executeJavaScript(payload);
}

/**
 * Handle shutdown message
 */
function handleShutdown(port: MessagePort): void {
  isShuttingDown = true;

  // Clear any pending timeouts
  if (currentTaskTimeout) {
    clearTimeout(currentTaskTimeout);
    currentTaskTimeout = null;
  }

  // Exit gracefully
  setTimeout(() => {
    process.exit(0);
  }, 100);
}

/**
 * Send progress update
 */
function sendProgress(port: MessagePort, taskId: string, percent: number, message?: string): void {
  const response: WorkerResponse = {
    type: 'PROGRESS',
    taskId,
    progress: { percent, message },
  };
  port.postMessage(response);
}

/**
 * Send completion response
 */
function sendComplete(port: MessagePort, taskId: string, payload: unknown): void {
  const response: WorkerResponse = {
    type: 'COMPLETE',
    taskId,
    payload,
  };
  port.postMessage(response);
}

/**
 * Send error response
 */
function sendError(port: MessagePort, taskId: string, error: Error): void {
  const response: WorkerResponse = {
    type: 'ERROR',
    taskId,
    error: {
      message: error.message,
      code: (error as unknown as { code?: string }).code || 'EXECUTION_ERROR',
      stack: error.stack,
    },
  };
  port.postMessage(response);
}

/**
 * Function registry for function-type tasks
 */
const functionRegistry = new Map<string, (...args: unknown[]) => unknown>();

/**
 * Register a function for execution
 */
export function registerFunction(name: string, fn: (...args: unknown[]) => unknown): void {
  functionRegistry.set(name, fn);
}

// Register built-in functions
registerFunction('ping', () => ({ pong: true, timestamp: Date.now() }));
registerFunction('echo', (message: unknown) => ({ echo: message }));
registerFunction('cpuIntensive', (iterations: unknown) => {
  const n = typeof iterations === 'number' ? iterations : 1000000;
  let result = 0;
  for (let i = 0; i < n; i++) {
    result += Math.sqrt(i);
  }
  return { result, iterations: n };
});
registerFunction('memoryIntensive', (size: unknown) => {
  const n = typeof size === 'number' ? size : 1000000;
  const array = new Array(n).fill(0).map((_, i) => i);
  return { size: array.length };
});

// Set up message handling
if (parentPort) {
  let port: MessagePort;

  parentPort.once('message', (message: { type: 'PORT'; port: MessagePort }) => {
    if (message.type === 'PORT') {
      port = message.port;
      activePort = port;
      port.on('message', (msg: ExecuteMessage | ShutdownMessage | ToolResultMessage) => {
        if (msg.type === 'TOOL_RESULT') {
            const pending = pendingToolCalls.get(msg.id);
            if (pending) {
                if (msg.error) {
                    pending.reject(new Error(msg.error.message));
                } else {
                    pending.resolve(msg.result);
                }
                pendingToolCalls.delete(msg.id);
            }
        } else {
            handleMessage(port, msg);
        }
      });
    }
  });
}

/**
 * Request execution of a tool via RPC
 */
async function useTool(name: string, args: unknown): Promise<unknown> {
    if (!parentPort) throw new Error("No parent port available for RPC");
    
    const id = IdGenerator.generate();
    
    return new Promise((resolve, reject) => {
        pendingToolCalls.set(id, { resolve, reject });
        
        const message: CallToolMessage = {
            type: 'CALL_TOOL',
            id,
            tool: name,
            args
        };
        
        // We need to send this to the PORT, not parentPort directly if using MessageChannel
        // But wait, the WorkerThreadEngine sends a PORT.
        // We don't have global access to 'port' variable here easily outside the scope.
        // Quick fix: Use parentPort first as fallback or refactor to store port.
        // In WorkerThreadEngine structure, 'port' is used for everything.
        // We need to capture 'port' globally.
        if (activePort) {
            activePort.postMessage(message);
        } else {
            reject(new Error("RPC Port also not active"));
        }
    });
}

let activePort: MessagePort | undefined;

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in worker:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in worker:', reason);
  process.exit(1);
});

/** @internal Test-only helper to reset shutdown state between tests */
export function _test_resetShutdownState(): void {
  isShuttingDown = false;
}

/** @internal Test-only helper to reset function registry between tests (TEST-046) */
export function _test_clearFunctionRegistry(): void {
  functionRegistry.clear();
  // Re-register built-in functions
  registerFunction('ping', () => ({ pong: true, timestamp: Date.now() }));
  registerFunction('echo', (message: unknown) => ({ echo: message }));
}
