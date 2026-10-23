/**
 * File System Skill Loader
 * Loads skills from Markdown files with YAML frontmatter.
 * @layer Infrastructure
 */
import * as glob from 'glob';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { v4 as uuidv4 } from 'uuid';
import { ISkillLoader, Skill } from '../../domain/skills';
import { SkillMetadataSchema } from '../../config/schema/definitions/skill.schema';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

export class FileSystemSkillLoader implements ISkillLoader {
  private readonly rootPath: string;

  constructor(config: { rootPath?: string } = {}, private readonly logger?: IStructuredLogger) {
    this.rootPath = config.rootPath || path.resolve(process.cwd(), 'skills');
  }

  private skillCache: Map<string, Skill> | null = null;
  private lastLoadTime = 0;
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async loadSkills(forceRefresh = false): Promise<Skill[]> {
    if (!forceRefresh && this.skillCache && (Date.now() - this.lastLoadTime < this.CACHE_TTL_MS)) {
      return Array.from(this.skillCache.values());
    }

    const pattern = '**/*.md';
    const files = await this.findFiles(pattern);
    const skills = new Map<string, Skill>();

    console.log(`[SkillLoader] Scanning for skills in: ${this.rootPath}`);

    for (const file of files) {
      try {
        const skill = await this.parseSkillFile(file);
        if (skill) {
          if (skills.has(skill.id)) {
            this.logger?.warn(`[SkillLoader] Duplicate Skill ID detection: ${skill.id} in ${file}. Ignoring duplicate.`);
            continue;
          }
          skills.set(skill.id, skill);
          this.logger?.log(`[SkillLoader] Loaded skill: ${skill.name} (${skill.id})`);
        }
      } catch (error: unknown) {
        this.logger?.warn(`[SkillLoader] Failed to parse skill file ${file}: ${this.getErrorMessage(error)}`);
      }
    }

    this.skillCache = skills;
    this.lastLoadTime = Date.now();
    return Array.from(skills.values());
  }

  async getSkill(skillId: string): Promise<Skill | null> {
    const skills = await this.loadSkills();
    // Cache is populated by loadSkills
    return this.skillCache?.get(skillId) || null;
  }

  private async findFiles(pattern: string): Promise<string[]> {
    return glob.glob(pattern, { cwd: this.rootPath, absolute: true });
  }

  private async parseSkillFile(filePath: string): Promise<Skill | null> {
    const content = await fs.readFile(filePath, 'utf-8');
    const parts = this.extractFrontMatter(content);

    if (!parts.frontMatter) {
      // Skipping files without frontmatter (not skills)
      return null;
    }

    // Parse YAML
    const rawMetadata = yaml.parse(parts.frontMatter);
    
    // Validate with Zod
    const result = SkillMetadataSchema.safeParse(rawMetadata);

    if (!result.success) {
      console.warn(`[SkillLoader] Invalid frontmatter in ${path.basename(filePath)}:`, result.error.message);
      return null;
    }

    const metadata = result.data;
    // Normalize to forward slashes to ensure consistent ID generation across platforms
    // glob returns forward slashes, but we handle backslashes just in case
    const slashPath = filePath.replace(/\\/g, '/');
    const id = path.posix.basename(slashPath, '.md');

    return {
      id: id,
      name: metadata.name,
      description: metadata.description,
      version: metadata.version,
      instructions: parts.body.trim(),
      sourcePath: filePath,
      metadata: metadata,
    };
  }

  private extractFrontMatter(content: string): { frontMatter: string | null; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) {
      return { frontMatter: null, body: content };
    }
    return {
      frontMatter: match[1],
      body: match[2],
    };
  }
}
