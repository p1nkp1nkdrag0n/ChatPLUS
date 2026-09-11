import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { llmApi, llmCatalogKey } from "../api/llm";
import { configuredDefault } from "../lib/apiSetup";
import type { LlmCatalog } from "@personasim/contracts";
import WelcomePage from "./WelcomePage";

const ApiSetupWizard = lazy(() => import("../components/setup/ApiSetupWizard"));

export default function WelcomeEntryPage() {
  const [entry, setEntry] = useState<"checking" | "welcome" | LlmCatalog>(
    "checking",
  );
  const catalog = useQuery({
    queryKey: llmCatalogKey,
    queryFn: llmApi.catalog,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    enabled: entry === "checking",
    retry: false,
  });
  useEffect(() => {
    document.title = "欢迎来到 Dearvale";
  }, []);
  useEffect(() => {
    if (
      entry === "checking" &&
      catalog.isFetchedAfterMount &&
      !catalog.isFetching &&
      catalog.isSuccess
    ) {
      setEntry(configuredDefault(catalog.data) ? "welcome" : catalog.data);
    }
  }, [
    entry,
    catalog.isFetchedAfterMount,
    catalog.isFetching,
    catalog.isSuccess,
    catalog.data,
  ]);
  if (entry === "welcome") return <WelcomePage />;
  const loading = (
    <div className="setup-entry" role="status">
      <Link className="setup-entry-brand" to="/">
        Dearvale
      </Link>
      <p>{catalog.isError ? "暂时没能读取模型配置。" : "正在翻开魔法手册…"}</p>
      {catalog.isError ? (
        <button className="setup-button" onClick={() => void catalog.refetch()}>
          重新读取配置
        </button>
      ) : (
        <span className="setup-loading-mark" aria-hidden="true">
          ✧
        </span>
      )}
      <Link to="/">返回官网</Link>
    </div>
  );
  if (entry === "checking") return loading;
  return (
    <Suspense fallback={loading}>
      <ApiSetupWizard
        initialCatalog={entry}
        onComplete={() => setEntry("welcome")}
      />
    </Suspense>
  );
}
