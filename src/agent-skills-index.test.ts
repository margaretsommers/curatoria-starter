import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_SKILLS_DISCOVERY_SCHEMA,
  AGENT_SKILLS_REGISTRY,
  buildAgentSkillIndexEntry,
  buildAgentSkillsDiscoveryIndex,
  readAgentSkillContent,
  sha256Digest,
} from './agent-skills-index';

test('buildAgentSkillsDiscoveryIndex matches RFC v0.2.0 shape', () => {
  const index = buildAgentSkillsDiscoveryIndex('https://curatoria.dev');

  assert.equal(index.$schema, AGENT_SKILLS_DISCOVERY_SCHEMA);
  assert.equal(index.skills.length, AGENT_SKILLS_REGISTRY.length);

  for (const skill of index.skills) {
    assert.match(skill.name, /^[a-z0-9-]+$/);
    assert.equal(skill.type, 'skill-md');
    assert.ok(skill.description.length > 0);
    assert.match(skill.url, /^https:\/\/curatoria\.dev\/\.well-known\/agent-skills\/.+\/SKILL\.md$/);
    assert.match(skill.digest, /^sha256:[a-f0-9]{64}$/);
  }
});

test('skill digests match on-disk artifact bytes', () => {
  for (const entry of AGENT_SKILLS_REGISTRY) {
    const content = readAgentSkillContent(entry);
    const indexed = buildAgentSkillIndexEntry(entry, 'https://curatoria.dev');

    assert.equal(indexed.digest, sha256Digest(content));
  }
});
