/** Reuse the authorized persisted user row as the branch point of a regeneration. */
export function resolvePiRegenerationUser<
  T extends {
    messageId?: unknown;
    parentMessageId?: unknown;
    isCreatedByUser?: unknown;
  },
>(messages: readonly T[], userMessageId: string, parentMessageId: string): T {
  const message = messages[messages.length - 1];
  if (
    message == null ||
    message.messageId !== userMessageId ||
    message.parentMessageId !== parentMessageId ||
    message.isCreatedByUser !== true
  ) {
    throw new Error('The original user message is unavailable for regeneration.');
  }
  return message;
}
