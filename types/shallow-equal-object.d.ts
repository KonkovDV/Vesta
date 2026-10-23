declare module 'shallow-equal-object' {
  export function shallowEqual<T extends object>(objA: T, objB: T): boolean;
}