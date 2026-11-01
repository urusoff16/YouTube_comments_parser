export class ExtensionError extends Error {
  constructor(code, fallbackMessage, details = {}, options = {}) {
    super(fallbackMessage, options);
    this.name = "ExtensionError";
    this.code = code;
    this.details = details;
  }
}

export function extensionError(code, fallbackMessage, details = {}, options = {}) {
  return new ExtensionError(code, fallbackMessage, details, options);
}

export function localizedErrorMessage(error, translate) {
  if (error?.code && typeof translate === "function") {
    const translated = translate(`error.${error.code}`, error.details);
    if (translated && translated !== `error.${error.code}`) return translated;
  }
  return error?.message || translate?.("error.unknown") || "Unknown error.";
}
