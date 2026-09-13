/** Only an HTTPS origin is saved. Credentials, paths and URL parameters are rejected. */
export function normalizeServerOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Error("请填写完整的 HTTPS 服务根地址，不包含路径、账号或查询参数。");
  if (!url.hostname || url.port === "0") throw new Error("服务地址或端口无效。");
  return url.origin;
}
export function isSameServer(origin: string, candidate: string): boolean {
  try {
    const url = new URL(candidate.startsWith("blob:") ? candidate.slice(5) : candidate);
    if (url.protocol === "wss:") url.protocol = "https:";
    return url.origin === origin && !url.username && !url.password;
  } catch { return false; }
}
