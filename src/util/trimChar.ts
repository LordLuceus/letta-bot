export const trimChar = (str: string, char: string): string => {
  const escaped = char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return str.replace(new RegExp(`^\\${escaped}+|\\${escaped}+$`, "g"), "");
};
