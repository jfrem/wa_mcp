export interface ChatFilterCache {
  includeChatNames: Set<string>;
  excludeChatNames: Set<string>;
  includeRegexes: RegExp[];
  excludeRegexes: RegExp[];
}

export function resolveProjectRelativePath(projectRoot: string, configuredPath: string | undefined, fallbackPath: string): string {
  const raw = String(configuredPath ?? "").trim();
  if (!raw) return fallbackPath;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) {
    return raw;
  }

  const projectName = projectRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const normalizedRelative = raw.replace(/\\/g, "/");
  const redundantPrefix = projectName ? `${projectName}/` : "";
  const sanitized = redundantPrefix && normalizedRelative.toLowerCase().startsWith(redundantPrefix)
    ? normalizedRelative.slice(redundantPrefix.length)
    : normalizedRelative;

  return sanitized.replace(/\//g, "\\");
}

export function normalizeChatName(chatName: string): string {
  return chatName.trim().toLowerCase();
}

export function compilePatternsStrict(patterns: string[], label: string): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Regex invalida en ${label}: "${pattern}". ${detail}`);
    }
  });
}

export function buildChatFilterCache(
  includeChats: string[],
  includePatterns: string[],
  excludeChats: string[],
  excludePatterns: string[],
): ChatFilterCache {
  return {
    includeChatNames: new Set(includeChats.map(normalizeChatName)),
    excludeChatNames: new Set(excludeChats.map(normalizeChatName)),
    includeRegexes: compilePatternsStrict(includePatterns, "includePatterns"),
    excludeRegexes: compilePatternsStrict(excludePatterns, "excludePatterns"),
  };
}

function matchesAnyPattern(chatName: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(chatName));
}

export function shouldHandleChatName(chatName: string, cache: ChatFilterCache): boolean {
  const normalized = normalizeChatName(chatName);
  if (cache.excludeChatNames.has(normalized) || matchesAnyPattern(chatName, cache.excludeRegexes)) {
    return false;
  }

  const hasIncludes = cache.includeChatNames.size > 0 || cache.includeRegexes.length > 0;
  if (!hasIncludes) return true;

  return cache.includeChatNames.has(normalized) || matchesAnyPattern(chatName, cache.includeRegexes);
}
