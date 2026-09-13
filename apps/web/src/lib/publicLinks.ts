/** Public-site links are optional until a real website has been deployed. */
export function getWebsiteUrl(): string | undefined {
  return (
    import.meta.env["VITE_WEBSITE_URL"]?.trim() ||
    (import.meta.env.DEV ? "http://127.0.0.1:5174/" : undefined)
  );
}
