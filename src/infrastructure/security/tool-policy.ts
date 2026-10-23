export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

export const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  python: "exec",
  "apply-patch": "apply_patch",
  apply_patch: "exec",
  fs_read: "read",
  read_file: "read",
};

export const TOOL_GROUPS: Record<string, string[]> = {
  // NOTE: Keep canonical (lowercase) tool names here.
  "group:memory": ["memory_search", "memory_get", "memory_store", "memory_forget"],
  "group:web": ["web_search", "web_fetch"],
  // Basic workspace/file tools
  "group:fs": ["read", "write", "edit", "apply_patch", "search_text"],
  // Host/runtime execution tools
  "group:runtime": ["exec", "process", "finish"],
  // Session management tools
  "group:sessions": [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
  ],
  // UI helpers
  "group:ui": ["browser", "canvas"],
  // Automation + infra
  "group:automation": ["cron", "gateway"],
  // Messaging surface
  "group:messaging": ["message"],
  // Nodes + device tools
  "group:nodes": ["nodes"],
  // All OpenClaw native tools (excludes provider plugins).
  "group:openclaw": [
    "browser",
    "canvas",
    "nodes",
    "cron",
    "message",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
    "memory_search",
    "memory_get",
    "web_search",
    "web_fetch",
    "image",
  ],
};

const TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: ["session_status"],
  },
  coding: {
    allow: ["group:fs", "group:runtime", "group:sessions", "group:memory", "image"],
  },
  messaging: {
    allow: [
      "group:messaging",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "session_status",
    ],
  },
  full: {},
};

export function normalizeToolName(name: string) {
  const normalized = name.trim().toLowerCase();
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function normalizeToolList(list?: string[]) {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolName).filter(Boolean);
}

export type ToolPolicyLike = {
  allow?: string[];
  deny?: string[];
};

export type PluginToolGroups = {
  all: string[];
  byPlugin: Map<string, string[]>;
};

export type AllowlistResolution = {
  policy: ToolPolicyLike | undefined;
  unknownAllowlist: string[];
  strippedAllowlist: boolean;
};

export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = TOOL_GROUPS[value];
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(value);
  }
  return Array.from(new Set(expanded));
}

export function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.allow) {
      continue;
    }
    for (const value of policy.allow) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
    }
  }
  return entries;
}

export function buildPluginToolGroups<T extends { name: string }>(params: {
  tools: T[];
  toolMeta: (tool: T) => { pluginId: string } | undefined;
}): PluginToolGroups {
  const all: string[] = [];
  const byPlugin = new Map<string, string[]>();
  for (const tool of params.tools) {
    const meta = params.toolMeta(tool);
    if (!meta) {
      continue;
    }
    const name = normalizeToolName(tool.name);
    all.push(name);
    const pluginId = meta.pluginId.toLowerCase();
    const list = byPlugin.get(pluginId) ?? [];
    list.push(name);
    byPlugin.set(pluginId, list);
  }
  return { all, byPlugin };
}

export function expandPluginGroups(
  list: string[] | undefined,
  groups: PluginToolGroups,
): string[] | undefined {
  if (!list || list.length === 0) {
    return list;
  }
  const expanded: string[] = [];
  for (const entry of list) {
    const normalized = normalizeToolName(entry);
    if (normalized === "group:plugins") {
      if (groups.all.length > 0) {
        expanded.push(...groups.all);
      } else {
        expanded.push(normalized);
      }
      continue;
    }
    const tools = groups.byPlugin.get(normalized);
    if (tools && tools.length > 0) {
      expanded.push(...tools);
      continue;
    }
    expanded.push(normalized);
  }
  return Array.from(new Set(expanded));
}

export function expandPolicyWithPluginGroups(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
): ToolPolicyLike | undefined {
  if (!policy) {
    return undefined;
  }
  return {
    allow: expandPluginGroups(policy.allow, groups),
    deny: expandPluginGroups(policy.deny, groups),
  };
}

export function stripPluginOnlyAllowlist(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
  coreTools: Set<string>,
): AllowlistResolution {
  if (!policy?.allow || policy.allow.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const normalized = normalizeToolList(policy.allow);
  if (normalized.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const pluginIds = new Set(groups.byPlugin.keys());
  const pluginTools = new Set(groups.all);
  const unknownAllowlist: string[] = [];
  let hasCoreEntry = false;
  for (const entry of normalized) {
    if (entry === "*") {
      hasCoreEntry = true;
      continue;
    }
    const isPluginEntry =
      entry === "group:plugins" || pluginIds.has(entry) || pluginTools.has(entry);
    const expanded = expandToolGroups([entry]);
    const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
    if (isCoreEntry) {
      hasCoreEntry = true;
    }
    if (!isCoreEntry && !isPluginEntry) {
      unknownAllowlist.push(entry);
    }
  }
  const strippedAllowlist = !hasCoreEntry;
  // When an allowlist contains only plugin tools, we strip it to avoid accidentally
  // disabling core tools. Users who want additive behavior should prefer `tools.alsoAllow`.
  if (strippedAllowlist) {
    // Note: logging happens in the caller (pi-tools/tools-invoke) after this function returns.
    // We keep this note here for future maintainers.
  }
  return {
    policy: strippedAllowlist ? { ...policy, allow: undefined } : policy,
    unknownAllowlist: Array.from(new Set(unknownAllowlist)),
    strippedAllowlist,
  };
}

export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  const resolved = TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}

// ── Owner-only tools ────────────────────────────────────────────

export const OWNER_ONLY_TOOL_NAME_FALLBACKS: Set<string> = new Set([
  "whatsapp_login",
  "cron",
  "gateway",
]);

export function isOwnerOnlyToolName(name: string): boolean {
  return OWNER_ONLY_TOOL_NAME_FALLBACKS.has(normalizeToolName(name));
}

export function isOwnerOnlyTool(tool: { name: string; ownerOnly?: boolean }): boolean {
  if (tool.ownerOnly === true) {
    return true;
  }
  return isOwnerOnlyToolName(tool.name);
}

export function applyOwnerOnlyToolPolicy<T extends { name: string }>(
  tools: T[],
  isOwner: boolean,
): T[] {
  if (isOwner) {
    return tools;
  }
  return tools.filter((t) => !isOwnerOnlyTool(t));
}

// ── Policy merge & filter ───────────────────────────────────────

export function mergeAlsoAllowPolicy(
  policy: ToolPolicyLike | undefined,
  alsoAllow: string[] | undefined,
): ToolPolicyLike | undefined {
  if (!policy) {
    return undefined;
  }
  if (!alsoAllow || alsoAllow.length === 0) {
    return policy;
  }
  const merged = new Set([
    ...(policy.allow ?? []),
    ...alsoAllow,
  ]);
  return {
    ...policy,
    allow: Array.from(merged),
  };
}

export function filterToolsByPolicy<T extends { name: string }>(
  tools: T[],
  policy?: ToolPolicyLike,
): T[] {
  if (!policy) {
    return tools;
  }
  const expandedAllow = policy.allow ? expandToolGroups(policy.allow) : undefined;
  const expandedDeny = policy.deny ? expandToolGroups(policy.deny) : undefined;
  const hasWildcardAllow = expandedAllow?.includes("*") ?? false;
  const hasWildcardDeny = expandedDeny?.includes("*") ?? false;

  return tools.filter((tool) => {
    const name = normalizeToolName(tool.name);
    // Deny takes precedence
    if (hasWildcardDeny) {
      return false;
    }
    if (expandedDeny?.includes(name)) {
      return false;
    }
    // Allow check
    if (expandedAllow) {
      return hasWildcardAllow || expandedAllow.includes(name);
    }
    return true;
  });
}

// ── Pipeline ────────────────────────────────────────────────────

export type ToolPolicyPipelineStep = {
  policy: ToolPolicyLike | undefined;
  label: string;
  stripPluginOnlyAllowlist?: boolean;
};

export function buildDefaultToolPolicyPipelineSteps(params: {
  profilePolicy?: ToolPolicyLike;
  profile?: string;
  providerProfilePolicy?: ToolPolicyLike;
  providerProfile?: string;
  globalPolicy?: ToolPolicyLike;
  globalProviderPolicy?: ToolPolicyLike;
  agentPolicy?: ToolPolicyLike;
  agentProviderPolicy?: ToolPolicyLike;
  agentId?: string;
  groupPolicy?: ToolPolicyLike;
}): readonly ToolPolicyPipelineStep[] {
  const agentId = params.agentId?.trim() ?? '';
  const steps: ToolPolicyPipelineStep[] = [
    {
      policy: params.profilePolicy,
      label: `profile(${params.profile ?? ''})`,
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.providerProfilePolicy,
      label: `byProvider.profile(${params.providerProfile ?? ''})`,
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.globalPolicy,
      label: 'tools.allow',
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.globalProviderPolicy,
      label: 'tools.byProvider.allow',
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.agentPolicy,
      label: `agents.${agentId}.tools.allow`,
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.agentProviderPolicy,
      label: `agents.${agentId}.tools.byProvider.allow`,
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.groupPolicy,
      label: 'group tools.allow',
      stripPluginOnlyAllowlist: true,
    },
  ];
  return Object.freeze(steps);
}

export function applyToolPolicyPipeline<T extends { name: string }>(params: {
  tools: T[];
  toolMeta: (tool: T) => { pluginId: string } | undefined;
  warn: (message: string) => void;
  steps: readonly ToolPolicyPipelineStep[];
}): T[] {
  const pluginGroups = buildPluginToolGroups({
    tools: params.tools,
    toolMeta: params.toolMeta,
  });
  const coreTools = new Set(
    params.tools
      .filter((t) => !params.toolMeta(t))
      .map((t) => normalizeToolName(t.name)),
  );

  let current = params.tools;

  for (const step of params.steps) {
    if (!step.policy) {
      continue;
    }
    const expanded = expandPolicyWithPluginGroups(step.policy, pluginGroups);
    if (!expanded) {
      continue;
    }

    if (step.stripPluginOnlyAllowlist) {
      const resolution = stripPluginOnlyAllowlist(expanded, pluginGroups, coreTools);
      if (resolution.unknownAllowlist.length > 0) {
        params.warn(
          `${step.label}: unknown entries in allowlist: ${resolution.unknownAllowlist.join(', ')}`,
        );
      }
      if (resolution.strippedAllowlist) {
        params.warn(
          `${step.label}: allowlist contains only plugin tools — stripping to avoid disabling core tools`,
        );
        continue;
      }
      current = filterToolsByPolicy(current, resolution.policy);
    } else {
      current = filterToolsByPolicy(current, expanded);
    }
  }

  return current;
}
