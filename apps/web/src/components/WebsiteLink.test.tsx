import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebsiteLink } from "./WebsiteLink";

afterEach(() => vi.unstubAllEnvs());

describe("application links to its independent website", () => {
  it("opens the configured website without replacing the current application", () => {
    vi.stubEnv("VITE_WEBSITE_URL", "https://dearvale.example/");
    const markup = renderToStaticMarkup(<WebsiteLink />);
    expect(markup).toContain('href="https://dearvale.example/"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("访问官网");
  });

  it("omits undeployed public links from production applications", () => {
    vi.stubEnv("VITE_WEBSITE_URL", "");
    vi.stubEnv("DEV", false);
    expect(renderToStaticMarkup(<WebsiteLink />)).toBe("");
  });
});
