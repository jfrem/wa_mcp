import type { ActionStrategy, ActionStrategyName } from "./types.js";
import { unansweredMessageStrategy } from "./strategies/unanswered-message.js";
import { followUpSimpleStrategy } from "./strategies/follow-up-simple.js";

const registry = new Map<string, ActionStrategy>([
  [unansweredMessageStrategy.name, unansweredMessageStrategy],
  [followUpSimpleStrategy.name, followUpSimpleStrategy],
]);

export function getActionStrategy(name: string): ActionStrategy | undefined {
  return registry.get(name.trim());
}

export function listActionStrategies(): ActionStrategyName[] {
  return [...registry.keys()] as ActionStrategyName[];
}
