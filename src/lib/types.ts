/**
 * Shared types across tools. Kept minimal on purpose — the tool layer owns
 * its own validation schemas (zod) for input, and returns plain JSON.
 */

export type ToolResult =
  | { success: true; data: unknown; message?: string }
  | { success: false; error: string; code?: string };

export interface ToolContext {
  // Reserved for future context (e.g. current session id injection).
  // Kept as an empty object so tool signatures don't need to change later.
  readonly _reserved?: never;
}

export type MemoryType = 'episodic' | 'semantic';
export type LifecycleState = 'active' | 'ephemeral' | 'archived';
export type LearningCategory =
  | 'pattern'
  | 'mistake'
  | 'insight'
  | 'research'
  | 'architecture'
  | 'infrastructure'
  | 'tool'
  | 'workflow'
  | 'performance'
  | 'security';
