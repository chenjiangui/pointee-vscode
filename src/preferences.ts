export const COPY_FIELDS = [
  "source", "component", "page", "anchor", "handlers", "selector",
  "position", "repeated", "text", "layout", "styles", "props",
] as const;

export const DEFAULT_COPY_FIELDS = COPY_FIELDS.filter(field => !["layout", "styles", "props"].includes(field));

export const DEFAULTS: Record<string, string | boolean> = {
  theme: "system", copyHtml: "root", copyDepth: "3", copyHtmlFallback: true, copyFence: true,
  redlineUnit: "px", redlinePrecision: "whole", redlinePillPlacement: "beside",
  redlineGuides: true, redlineQuietOverlay: false, redlineZeroPills: true,
  editGroups: "standard", editTokenControls: "both", editDeepShaderCapture: false,
  inspectorLayerAid: "ghost",
};

export function toPagePreferences(get: (key: string, fallback: any) => any): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = get(key, fallback);
    result[key] = typeof fallback === "boolean" ? (value ? "on" : "off") : String(value);
  }
  const fields: string[] = get("copyFields", DEFAULT_COPY_FIELDS);
  for (const field of COPY_FIELDS) {
    result[`copy${field[0].toUpperCase()}${field.slice(1)}`] = fields.includes(field) ? "on" : "off";
  }
  return result;
}
