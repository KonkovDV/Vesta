declare module 'croner' {
  export default class Cron {
    constructor(pattern: string, options?: Record<string, unknown>);
    nextRun(from?: Date): Date | null;
  }
}
