import { createContext, useContext } from "react";
import type { HostedInfo, HostedMe } from "../api/hosted";

export interface HostedContextValue {
  info: HostedInfo;
  session: HostedMe;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}
export const HostedContext = createContext<HostedContextValue | null>(null);
export function useHosted(): HostedContextValue | null {
  return useContext(HostedContext);
}
