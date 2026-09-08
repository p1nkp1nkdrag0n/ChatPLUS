import {
  History,
  Mail,
  MessageCircle,
  Settings,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
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

const SECONDARY_NAVIGATION: NavigationItem[] = [
  { to: "/settings", label: "设置", icon: Settings },
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
  const location = useLocation();
  const [activeCharacterId, setActiveCharacterId] =
    useState(readActiveCharacter);
  useEffect(() => {
    document.title = "Dearvale";
  }, [location.pathname]);
  const previousActiveCharacterId = useRef(activeCharacterId);
  useEffect(() => subscribeActiveCharacter(setActiveCharacterId), []);
  const charactersQuery = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
  });
  const currentCharacter = charactersQuery.data?.characters.find(
    (character) =>
      character.id === activeCharacterId && character.status === "published",
  );
  const activationId = currentCharacter?.id;
  const activationQuery = useQuery({
    queryKey: ["agent-activation", activeCharacterId],
    queryFn: async () => {
      const snapshot = await api.agents.activate(activeCharacterId!);
      primeAgentOverview(queryClient, activeCharacterId!, snapshot);
      return snapshot;
    },
    enabled: Boolean(activationId),
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
  useAgentEvents(activationId);
  const root = activationId ? `/characters/${activationId}` : undefined;
  const chat = /\/characters\/[^/]+\/chat$/.test(location.pathname);
  const memories =
    /\/(timeline|relationship-archive|relationship-share|keepsakes)(\/|$)/.test(
      location.pathname,
    );
  const primaryNavigation: NavigationItem[] = [
    { to: root ? `${root}/chat` : "/chat", label: "对话", icon: MessageCircle },
    {
      to: root ? `${root}/correspondence` : "/mailbox",
      label: "书信",
      icon: Mail,
      activePrefixes: ["/letters/", "/correspondence/threads/"],
    },
    {
      to: root ? `${root}/timeline` : "/timeline",
      label: "记忆",
      icon: History,
      activePrefixes: root
        ? [
            `${root}/relationship-archive`,
            `${root}/relationship-share`,
            `${root}/keepsakes`,
            "/keepsakes/",
            "/timeline",
          ]
        : ["/keepsakes/"],
    },
    {
      to: "/characters",
      label: "角色",
      icon: UserRound,
      end: true,
      activePrefixes: [
        "/create",
        "/import",
        ...(location.pathname.endsWith("/edit") ? [location.pathname] : []),
      ],
    },
  ];

  return (
    <div className={`app-shell${chat ? " app-shell--chat" : ""}`}>
      <aside className="app-nav" aria-label="主导航">
        <NavLink
          className="app-nav__brand"
          to="/welcome"
          aria-label="Dearvale 欢迎页"
        >
          <span className="app-nav__brand-mark" aria-hidden="true">
            <img src="/dearvale/art/botanical.png" alt="" />
          </span>
          <span>Dearvale</span>
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

        {!chat ? (
          <img
            className="app-nav__flowers"
            src="/dearvale/art/botanical.png"
            alt=""
          />
        ) : null}
      </aside>

      <main className="app-main">
        {memories ? (
          <nav className="memory-navigation" aria-label="记忆分类">
            <Link
              to={root ? `${root}/timeline` : "/timeline"}
              className={
                location.pathname.endsWith("/timeline") ? "is-active" : ""
              }
            >
              共同经历
            </Link>
            {root ? (
              <>
                <Link
                  to={`${root}/relationship-archive`}
                  className={
                    location.pathname.includes("relationship-")
                      ? "is-active"
                      : ""
                  }
                >
                  关系档案
                </Link>
                <Link
                  to={`${root}/keepsakes`}
                  className={
                    location.pathname.includes("keepsakes") ? "is-active" : ""
                  }
                >
                  纪念物
                </Link>
              </>
            ) : null}
          </nav>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
