import { Constants } from '@librechat/agents';
import { Tools } from 'librechat-data-provider';
import { DELETE_MEMORY_TOOL_NAME, SET_MEMORY_TOOL_NAME } from '../memoryToolNames';

export const PI_CALCULATOR_TOOL_NAME = 'calculator';
export const PI_BASH_TOOL_NAME: typeof Constants.BASH_TOOL = Constants.BASH_TOOL;
export const PI_READ_FILE_TOOL_NAME: typeof Constants.READ_FILE = Constants.READ_FILE;
export const PI_SKILL_TOOL_NAME: typeof Constants.SKILL_TOOL = Constants.SKILL_TOOL;
export const PI_SET_MEMORY_TOOL_NAME: typeof SET_MEMORY_TOOL_NAME = SET_MEMORY_TOOL_NAME;
export const PI_DELETE_MEMORY_TOOL_NAME: typeof DELETE_MEMORY_TOOL_NAME = DELETE_MEMORY_TOOL_NAME;
export const PI_WEB_SEARCH_TOOL_NAME: typeof Tools.web_search = Tools.web_search;

export type PiSupportedHostTool =
  | typeof Tools.file_search
  | typeof PI_WEB_SEARCH_TOOL_NAME
  | typeof PI_CALCULATOR_TOOL_NAME
  | typeof PI_BASH_TOOL_NAME
  | typeof PI_READ_FILE_TOOL_NAME
  | typeof PI_SKILL_TOOL_NAME
  | typeof PI_SET_MEMORY_TOOL_NAME
  | typeof PI_DELETE_MEMORY_TOOL_NAME;
export const PI_SUPPORTED_HOST_TOOLS: readonly PiSupportedHostTool[] = [
  Tools.file_search,
  PI_WEB_SEARCH_TOOL_NAME,
  PI_CALCULATOR_TOOL_NAME,
  PI_BASH_TOOL_NAME,
  PI_READ_FILE_TOOL_NAME,
  PI_SKILL_TOOL_NAME,
  PI_SET_MEMORY_TOOL_NAME,
  PI_DELETE_MEMORY_TOOL_NAME,
];

export function isPiCodeExecutionToolName(
  value: unknown,
): value is typeof PI_BASH_TOOL_NAME | typeof PI_READ_FILE_TOOL_NAME {
  return value === PI_BASH_TOOL_NAME || value === PI_READ_FILE_TOOL_NAME;
}

/** Skill file results may update the run-local managed Code API context. */
export function isPiCodeSessionAwareToolName(value: unknown): value is typeof PI_SKILL_TOOL_NAME {
  return value === PI_SKILL_TOOL_NAME;
}

export function isPiSupportedHostToolName(value: unknown): value is PiSupportedHostTool {
  return PI_SUPPORTED_HOST_TOOLS.some((name) => name === value);
}
