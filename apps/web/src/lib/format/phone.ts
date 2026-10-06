/** `14155550142` shows as `+1 •••• 0142`: enough to recognise, nothing more. */
export const maskedPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 6) return `+${digits}`;
  return `+${digits.slice(0, Math.max(1, digits.length - 10))} •••• ${digits.slice(-4)}`;
};
