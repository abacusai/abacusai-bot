export interface PreviewEvent {
  conversationKey: string;
  path?: string;
  url?: string;
}
export interface PreviewConsumer {
  owns(key: string): boolean;
  open(event: PreviewEvent): void;
}
const consumers = new Set<PreviewConsumer>();
export const registerPreviewConsumer = (
  consumer: PreviewConsumer
): (() => void) => {
  consumers.add(consumer);
  return () => {
    consumers.delete(consumer);
  };
};
export const dispatchPreview = (event: PreviewEvent): boolean => {
  for (const consumer of consumers)
    if (consumer.owns(event.conversationKey)) {
      consumer.open(event);
      return true;
    }
  return false;
};
