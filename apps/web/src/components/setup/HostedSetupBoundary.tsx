import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { llmApi, userModelSettingsKey } from "../../api/llm";
import { useHosted } from "../../hooks/useHosted";
import { ErrorBlock, LoadingBlock } from "../Feedback";

/** Account state protects every entry route, including bookmarked chat links. */
export function HostedSetupBoundary({ children }: { children: ReactNode }) {
  const hosted = useHosted();
  const location = useLocation();
  const required = !!hosted && hosted.session.user.role !== "admin";
  const settings = useQuery({
    queryKey: userModelSettingsKey,
    queryFn: llmApi.userSettings,
    enabled: required,
    staleTime: 30_000,
    retry: false,
  });
  if (!required) return children;
  if (settings.isPending)
    return <LoadingBlock label="正在读取账号模型设置…" fullPage />;
  if (!settings.data)
    return (
      <div className="hosted-auth">
        <ErrorBlock error={settings.error} />
        <button
          className="button button--primary"
          onClick={() => void settings.refetch()}
        >
          重新读取设置
        </button>
        <button className="text-button" onClick={() => void hosted.logout()}>
          退出当前账号
        </button>
      </div>
    );
  if (!settings.data.onboardingCompleted && location.pathname !== "/setup")
    return <Navigate to="/setup" replace />;
  if (settings.data.onboardingCompleted && location.pathname === "/setup")
    return <Navigate to="/welcome" replace />;
  return children;
}
