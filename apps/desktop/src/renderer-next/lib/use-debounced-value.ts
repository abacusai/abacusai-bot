import { useEffect, useState } from "react";
/** Delays query inputs; the control itself remains immediate. */
export const useDebouncedValue = <T>(value: T, wait: number): T => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), wait);
    return () => clearTimeout(timer);
  }, [value, wait]);
  return settled;
};
