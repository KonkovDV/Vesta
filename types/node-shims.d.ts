/* Auto-generated shims to satisfy TypeScript in environments without Node typings or node_modules.
   These declarations are intentionally permissive and should be replaced by proper @types packages
   when a full Node toolchain is available (npm install). */

// Third-party modules used by tooling (schema/policy linters)
declare module 'glob' {
  export function glob(pattern: string, options?: any): Promise<string[]>;
}

declare module 'chalk' {
  const chalk: any;
  export default chalk;
}

declare module 'ajv' {
  export type ErrorObject = any;
  class Ajv {
    constructor(opts?: any);
    compile(schema: any): ((data: any) => boolean) & { errors?: any[] };
  }
  export default Ajv;
}

declare module 'ajv-formats' {
  export default function addFormats(ajv: any): any;
}