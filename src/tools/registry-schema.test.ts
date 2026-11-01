import { describe, expect, it } from 'vitest';
import { toMcpToolList } from './registry.js';

describe('published MCP input schemas', () => {
  it('exposes every input field after Zod conversion', () => {
    const tools = toMcpToolList();
    expect(tools).toHaveLength(25);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      if (tool.name !== 'memory_health') {
        expect(Object.keys(tool.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
      }
    }
    const learn = tools.find((tool) => tool.name === 'memory_learn')!.inputSchema;
    expect(learn.required).toEqual(expect.arrayContaining(['category', 'content']));
    expect(learn.required).not.toContain('project');
    expect(learn.properties).toMatchObject({
      content: { type: 'string', minLength: 1, maxLength: 10000 },
      tags: { type: 'array', items: { type: 'string' } },
    });
  });
});
