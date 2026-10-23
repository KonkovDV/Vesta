/**
 * Skill Schema Definitions
 * @layer Configuration/Schema
 */
import { z } from 'zod';

export const SkillMetadataSchema = z.object({
  name: z.string().min(1, "Skill name is required"),
  description: z.string().min(10, "Description must be at least 10 characters"),
  version: z.string().default("1.0.0"),
  type: z.enum(["task", "knowledge", "tool"]).default("task"),
  tags: z.array(z.string()).optional(),
}).catchall(z.any());

export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

export const SkillSchema = SkillMetadataSchema.extend({
    id: z.string().uuid().or(z.string()),
    instructions: z.string(),
    sourcePath: z.string(),
});
