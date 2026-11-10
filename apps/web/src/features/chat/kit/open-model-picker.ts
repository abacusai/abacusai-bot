/** Opens the chat's model picker, from a card or line inside the chat. */
export const openModelPicker = (from: HTMLElement): void =>
  from
    .closest('[data-slot="chat-view"]')
    ?.querySelector<HTMLButtonElement>('[data-slot="chat-model-picker"]')
    ?.click();
