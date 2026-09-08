import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { rememberApplicationEntry } from "./entryPreferences";

export function ApplicationEntryTracker() {
  const { pathname } = useLocation();
  useEffect(() => rememberApplicationEntry(pathname), [pathname]);
  return <Outlet />;
}
