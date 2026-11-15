declare global {
  interface Window {
    __piDesktopResourceUrl?: (url: string) => string;
  }
}

export function rendererResourceUrl(url: string): string {
  return typeof window === "undefined" ? url : window.__piDesktopResourceUrl?.(url) ?? url;
}
