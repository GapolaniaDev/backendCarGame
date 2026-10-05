// Shared primitive aliases used across the runtime.

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

/** Anything serialisable to JSON via JSON.stringify without losing data. */
export type JsonObject = { [key: string]: Json };

/** Opaque typed result wrapper — discriminated union narrows at use sites. */
export type Some<T> = T;