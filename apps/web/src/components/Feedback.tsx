import { AlertCircle, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError } from "../api/types";

export function LoadingBlock({ label = "正在加载…", fullPage = false }) {
  return (
    <div
      className={`loading-block${fullPage ? " loading-block--full" : ""}`}
      role="status"
    >
      <LoaderCircle aria-hidden="true" className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBlock({
  error,
  action,
}: {
  error: unknown;
  action?: ReactNode;
}) {
  const title = error instanceof ApiError ? error.message : "加载时遇到问题";
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <div className="error-block" role="alert">
      <AlertCircle aria-hidden="true" size={22} />
      <div>
        <strong>{title}</strong>
        {issues.length > 0 ? (
          <ul>
            {issues.slice(0, 5).map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                {issue.path ? `${issue.path}：` : ""}
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        {action}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__line" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
