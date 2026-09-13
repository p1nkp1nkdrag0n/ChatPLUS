import type { ReactNode } from "react";
import { getWebsiteUrl } from "../lib/publicLinks";

export function WebsiteLink({
  className,
  children = "访问官网",
}: {
  className?: string;
  children?: ReactNode;
}) {
  const href = getWebsiteUrl();
  if (!href) return null;
  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
