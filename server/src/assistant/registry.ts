/**
 * Every tool the assistant has (docs/plan.md, Appendix E "Tool registry"): notes and reminders (tools.ts), and the
 * person's messages (S10) where they connected a messaging service.
 */
import { MESSAGE_TOOLS } from '../messaging/tools.ts';
import { BASE_TOOLS, type Tool } from './tools.ts';

export const TOOLS: Tool[] = [...BASE_TOOLS, ...MESSAGE_TOOLS];
export const toolByName = new Map(TOOLS.map((x) => [x.name, x]));

/** The tools offered in a turn: the messaging ones only while the person's messaging is connected. */
export function toolsFor(o: { messaging: boolean }): Tool[] {
  return o.messaging ? TOOLS : BASE_TOOLS;
}
