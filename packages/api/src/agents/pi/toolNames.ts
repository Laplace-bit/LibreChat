import { Tools } from 'librechat-data-provider';

export const PI_CALCULATOR_TOOL_NAME = 'calculator';

export type PiSupportedHostTool = typeof Tools.file_search | typeof PI_CALCULATOR_TOOL_NAME;
export const PI_SUPPORTED_HOST_TOOLS: readonly PiSupportedHostTool[] = [
  Tools.file_search,
  PI_CALCULATOR_TOOL_NAME,
];

export function isPiSupportedHostToolName(value: unknown): value is PiSupportedHostTool {
  return PI_SUPPORTED_HOST_TOOLS.some((name) => name === value);
}
