// A Reading list preference in Herdr's live settings.json. Other settings stay intact.
export const PREVIEW_SETTING = "readlist";

export function previewMode(text) {
  try {
    return JSON.parse(text ?? "{}")?.[PREVIEW_SETTING]?.space_preview === "system" ? "system" : "builtin";
  } catch {
    return "builtin";
  }
}

export function withPreviewMode(text, mode) {
  if (mode !== "builtin" && mode !== "system") throw new Error("Unknown Space preview mode");
  const data = JSON.parse(text ?? "{}");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Herdr settings");
  const readlist = data[PREVIEW_SETTING];
  if (readlist !== undefined && (!readlist || typeof readlist !== "object" || Array.isArray(readlist))) {
    throw new Error("Invalid Reading list settings");
  }
  return JSON.stringify({ ...data, [PREVIEW_SETTING]: { ...readlist, space_preview: mode } }, null, 2) + "\n";
}
