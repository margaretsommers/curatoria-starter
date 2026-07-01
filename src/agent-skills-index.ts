import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Request, Response } from 'express';
import { requestBaseUrl } from './discovery';
import { REPO_ROOT } from './paths';

export const AGENT_SKILLS_DISCOVERY_SCHEMA =
  'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

export type AgentSkillType = 'skill-md' | 'archive';

export type AgentSkillRegistryEntry = {
  name: string;
  type: AgentSkillType;
  description: string;
  sourcePath: string;
  urlPath: string;
};

export type AgentSkillIndexEntry = {
  name: string;
  type: AgentSkillType;
  description: string;
  url: string;
  digest: string;
};

export type AgentSkillsDiscoveryIndex = {
  $schema: string;
  skills: AgentSkillIndexEntry[];
};

export const AGENT_SKILLS_REGISTRY: AgentSkillRegistryEntry[] = [
  {
    name: 'curatoria-buyer',
    type: 'skill-md',
    description:
      'Discover Curatoria x402 catalogs for free and pay per markdown or zip asset in USDC on Base. Use for curatoria.dev buyer flows and design-catalog.json commerce.',
    sourcePath: path.join(
      REPO_ROOT,
      'public/.well-known/agent-skills/curatoria-buyer/SKILL.md',
    ),
    urlPath: '/.well-known/agent-skills/curatoria-buyer/SKILL.md',
  },
  {
    name: 'creator-setup',
    type: 'skill-md',
    description:
      'End-to-end creator onboarding for curatoria-starter: wallet setup, storage, publishing, testnet proof, and mainnet go-live.',
    sourcePath: path.join(
      REPO_ROOT,
      'public/.well-known/agent-skills/creator-setup/SKILL.md',
    ),
    urlPath: '/.well-known/agent-skills/creator-setup/SKILL.md',
  },
];

export function sha256Digest(content: Buffer | string): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

export function readAgentSkillContent(entry: AgentSkillRegistryEntry): Buffer {
  return fs.readFileSync(entry.sourcePath);
}

export function buildAgentSkillIndexEntry(
  entry: AgentSkillRegistryEntry,
  baseUrl?: string,
): AgentSkillIndexEntry {
  const content = readAgentSkillContent(entry);
  const origin = baseUrl?.replace(/\/$/, '');

  return {
    name: entry.name,
    type: entry.type,
    description: entry.description,
    url: origin ? `${origin}${entry.urlPath}` : entry.urlPath,
    digest: sha256Digest(content),
  };
}

export function buildAgentSkillsDiscoveryIndex(baseUrl?: string): AgentSkillsDiscoveryIndex {
  return {
    $schema: AGENT_SKILLS_DISCOVERY_SCHEMA,
    skills: AGENT_SKILLS_REGISTRY.map(entry => buildAgentSkillIndexEntry(entry, baseUrl)),
  };
}

export function findAgentSkill(name: string): AgentSkillRegistryEntry | undefined {
  return AGENT_SKILLS_REGISTRY.find(entry => entry.name === name);
}

export function handleAgentSkillsIndex(req: Request, res: Response): void {
  const index = buildAgentSkillsDiscoveryIndex(requestBaseUrl(req));

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/json');
  res.status(200).json(index);
}

export function handleAgentSkillFile(req: Request, res: Response): void {
  const skill = findAgentSkill(req.params.name);

  if (!skill) {
    res.status(404).json({ error: 'Skill not found' });
    return;
  }

  let content: Buffer;
  try {
    content = readAgentSkillContent(skill);
  } catch {
    res.status(404).json({ error: 'Skill not found' });
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('text/markdown');
  res.status(200).send(content);
}
