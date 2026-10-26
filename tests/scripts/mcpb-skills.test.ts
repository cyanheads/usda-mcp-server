/**
 * @fileoverview MCPB cleanup preserves the SDK skill loader while removing agent documentation.
 * @module tests/scripts/mcpb-skills.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { checkBundleEntries } from '../../scripts/lint-packaging.js';

describe('MCPB skills packaging', () => {
  it('removes dependency agent docs but retains the published guide', () => {
    const entries = [
      'skills/usda-guide/SKILL.md',
      'node_modules/example/skills/example/SKILL.md',
      'node_modules/example/framework-skills/build/SKILL.md',
      'node_modules/example/.claude/settings.json',
    ];
    expect(filterAgentDocEntries(entries)).toEqual([
      'node_modules/example/skills/example/SKILL.md',
      'node_modules/example/framework-skills/build/SKILL.md',
      'node_modules/example/.claude/settings.json',
    ]);
    expect(checkBundleEntries(entries.slice(0, 1), 'bundle')).toEqual([]);
    expect(checkBundleEntries(entries.slice(1), 'bundle')).toHaveLength(1);
  });

  it.each(['node_modules/', 'node_modules/example/node_modules/'])(
    'keeps runtime skill loader files under %s',
    (prefix) => {
      const entries = [
        `${prefix}@modelcontextprotocol/server/dist/ext/skills/index.mjs`,
        `${prefix}@modelcontextprotocol/server/dist/ext/skills/node/index.mjs`,
        `${prefix}@modelcontextprotocol/server/dist/ext/skills/index.d.mts`,
        `${prefix}@modelcontextprotocol/core/dist/ext/skills/index.mjs`,
      ];
      expect(filterAgentDocEntries(entries)).toEqual([]);
      expect(checkBundleEntries(entries, 'bundle')).toEqual([]);
    },
  );
});
