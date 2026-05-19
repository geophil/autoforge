function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toObject(value) {
  return value && typeof value === "object" ? value : {};
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const uiHelpersApi = {
  escHtml,
  oneLine,
  toArray,
  toObject,
  asNumber
};

if (typeof window !== "undefined") {
  window.UiHelpers = uiHelpersApi;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = uiHelpersApi;
}
