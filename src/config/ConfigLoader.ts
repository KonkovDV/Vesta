import { z } from 'zod';
import { AppConfigSchema, AppConfig } from './schema';
import { loadConfigFromEnv, getRawEnv } from './index';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { FSWatcher, watch } from 'fs';
import {  readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';

// Custom error for Schema Validation Failures
export class GeneticDefectError extends Error {
    constructor(public defects: string[]) {
        super(`Genetic Defects Detected in Configuration:\n${defects.join('\n')}`);
        this.name = "GeneticDefectError";
    }
}

export class ConfigLoader {
    private config: AppConfig | null = null;
    private readonly envPath: string;
    private watchers: FSWatcher[] = [];
    private readonly id = Math.random().toString(36).slice(2, 10);

    public get instanceId() { return this.id; }
    public get configValue() { return this.config; }

    constructor(envPath?: string) {
        this.envPath = envPath || path.resolve(process.cwd(), '.env');
    }

    /**
     * @deprecated Use DI container.resolve('ConfigLoader') instead.
     * This method will be removed in a future version.
     */
    public static getInstance(): ConfigLoader {
        console.warn('⚠️ ConfigLoader.getInstance() is deprecated. Use container.resolve("ConfigLoader") instead.');
        return new ConfigLoader();
    }

    public load(): AppConfig {
        dotenv.config({ path: this.envPath });

        // Reload environment variables to catch any changes if called multiple times
        const env = getRawEnv();

        try {
            // Use the centralized loading logic which handles validation and mapping
            // This ensures consistency with getConfig() and supports JEST_WORKER_ID
            this.config = loadConfigFromEnv(env);
            return this.config;
        } catch (error) {
             if (error instanceof z.ZodError) {
                 const defects = error.issues.map(e => `${e.path.join('.')}: ${e.message}`);
                 const defectError = new GeneticDefectError(defects);
                 console.error("❌ " + defectError.message);
                 throw defectError;
             }

            console.error("❌ Invalid Configuration:", error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    public async loadFromFile(filePath: string): Promise<AppConfig> {
        try {
            const content = await readFile(filePath, 'utf-8');
            // Support YAML or JSON
            const raw = filePath.endsWith('.json') ? JSON.parse(content) : parseYaml(content);
            
            // Validate against the schema directly
            const result = AppConfigSchema.safeParse(raw);
            
            if (!result.success) {
                 const defects = result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`);
                 throw new GeneticDefectError(defects);
            }
            
            this.config = result.data;
            console.log(`✅ Configuration Loaded from ${filePath}`);
            return this.config;
        } catch (error) {
             console.error(`❌ Failed to load config from ${filePath}:`, error);
             throw error;
        }
    }

    public watch(filePath: string, onChange: (config: AppConfig) => void): void {
        const watcher = watch(filePath, async (eventType) => {
            if (eventType === 'change') {
                try {
                    console.log(`↻ Config file changed: ${filePath}, reloading...`);
                    const newConfig = await this.loadFromFile(filePath);
                    onChange(newConfig);
                } catch (error) {
                    console.warn(`⚠ Hot-reload failed for ${filePath}, keeping previous config.`);
                }
            }
        });
        this.watchers.push(watcher);
    }

    public get(): AppConfig {
        if (!this.config) {
            return this.load(); // Lazy load if not explicitly loaded
        }
        return this.config;
    }
    
    public dispose(): void {
        this.watchers.forEach(w => w.close());
        this.watchers = [];
    }
}

