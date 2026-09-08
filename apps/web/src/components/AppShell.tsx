import {
  Archive,
  Braces,
  History,
  Library,
  Mail,
  MessageCircle,
  PackageOpen,
  Plus,
  Settings,
  Sprout,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { primeAgentOverview } from "../hooks/agentEventQueryKeys";
import { useAgentEvents } from "../hooks/useAgentEvents";
import {
  readActiveCharacter,
  subscribeActiveCharacter,
} from "../lib/activeCharacter";

interface NavigationItem {
  to: string;
  label: string;
  icon: LucideIcon;
  activePrefixes?: string[];
  end?: boolean;
}

const PRIMARY_NAVIGATION: NavigationItem[] = [
  { to: "/characters", label: "角色", icon: Library, end: true },
  { to: "/timeline", label: "共同经历", icon: History },
];

const SECONDARY_NAVIGATION: NavigationItem[] = [
  { to: "/create", label: "创建", icon: Plus },
  { to: "/settings", label: "设置", icon: Settings },
  { to: "/developer", label: "开发者", icon: Braces },
];

function NavItem({
  to,
  label,
  icon: Icon,
  activePrefixes,
  end,
}: NavigationItem) {
  const location = useLocation();
  const relatedRouteActive = activePrefixes?.some((prefix) =>
    location.pathname.startsWith(prefix),
  );
  return (
    <NavLink
      to={to}
      aria-label={label}
      title={label}
      {...(end === undefined ? {} : { end })}
      aria-current={relatedRouteActive ? "page" : undefined}
      className={({ isActive }) =>
        `app-nav__item${isActive || relatedRouteActive ? " is-active" : ""}`
      }
    >
      <Icon aria-hidden="true" size={20} strokeWidth={1.75} />
      <span>{label}</span>
    </NavLink>
  );
}

export function AppShell() {
  const queryClient = useQueryClient();
  const [activeCharacterId, setActiveCharacterId] =
    useState(readActiveCharacter);
  const previousActiveCharacterId = useRef(activeCharacterId);
  useEffect(() => subscribeActiveCharacter(setActiveCharacterId), []);
  const activationQuery = useQuery({
    queryKey: ["agent-activation", activeCharacterId],
    queryFn: async () => {
      const snapshot = await api.agents.activate(activeCharacterId!);
      primeAgentOverview(queryClient, activeCharacterId!, snapshot);
      return snapshot;
    },
    enabled: Boolean(activeCharacterId),
    staleTime: Number.POSITIVE_INFINITY,
  });
  useEffect(() => {
    const previousId = previousActiveCharacterId.current;
    previousActiveCharacterId.current = activeCharacterId;
    if (!activeCharacterId || previousId === activeCharacterId) return;

    const queryKey = ["agent-activation", activeCharacterId] as const;
    if (queryClient.getQueryData(queryKey) !== undefined) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  }, [activeCharacterId, queryClient]);
  useEffect(() => {
    if (!activeCharacterId || !activationQuery.data) return;
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["agent", activeCharacterId, "state"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["agent", activeCharacterId, "timeline"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["messages", activeCharacterId],
      }),
    ]);
  }, [activationQuery.data, activeCharacterId, queryClient]);
  useAgentEvents(activeCharacterId);
  const primaryNavigation = activeCharacterId
    ? [
        {
          to: `/characters/${activeCharacterId}/chat`,
          label: "对话",
          icon: MessageCircle,
        },
        {
          to: `/characters/${activeCharacterId}/correspondence`,
          label: "书信",
          icon: Mail,
          activePrefixes: ["/letters/", "/correspondence/threads/"],
        },
        {
          to: `/characters/${activeCharacterId}/relationship-archive`,
          label: "关系档案",
          icon: Archive,
          activePrefixes: [
            `/characters/${activeCharacterId}/relationship-share`,
          ],
        },
        {
          to: `/characters/${activeCharacterId}/keepsakes`,
          label: "纪念物",
          icon: PackageOpen,
          activePrefixes: ["/keepsakes/"],
        },
        ...PRIMARY_NAVIGATION,
      ]
    : PRIMARY_NAVIGATION;
  const mobileNavigation = primaryNavigation
    .filter(
      (item) => item.to !== "/timeline" && !item.to.endsWith("/keepsakes"),
    )
    .concat(SECONDARY_NAVIGATION.filter((item) => item.to === "/settings"));

  return (
    <div className="app-shell">
      <aside className="app-nav" aria-label="主导航">
        <NavLink
          className="app-nav__brand"
          to="/characters"
          aria-label="ChatPLUS 角色库"
        >
          <span className="app-nav__brand-mark" aria-hidden="true">
            <Sprout size={23} strokeWidth={1.4} />
          </span>
          <span>ChatPLUS</span>
        </NavLink>

        <nav className="app-nav__groups">
          <div className="app-nav__group">
            {primaryNavigation.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </div>
          <div className="app-nav__group app-nav__group--secondary">
            {SECONDARY_NAVIGATION.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </div>
        </nav>

        <div
          className="app-nav__runtime"
          title="数据保存在当前服务实例。使用外部模型时，所需上下文会发送给所配置的模型供应商。"
        >
          <span className="status-dot" />
          <div>
            <strong>关于数据</strong>
            <span>保存在当前服务实例</span>
            <NavLink to="/settings">查看模型与数据说明</NavLink>
          </div>
        </div>
      </aside>

      <main className="app-main">
        <Outlet />
      </main>

      <nav className="mobile-nav" aria-label="移动端主导航">
        {mobileNavigation.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
      </nav>
    </div>
  );
}
