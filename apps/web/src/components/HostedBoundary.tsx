import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, LogIn, Sprout } from "lucide-react";
import {
  hostedApi,
  hostedInfoKey,
  hostedMeKey,
  type HostedInfo,
  type HostedMe,
} from "../api/hosted";
import { ApiError } from "../api/types";
import { HostedContext } from "../hooks/useHosted";
import {
  configureHostedSession,
  HOSTED_SESSION_EXPIRED,
  resetHostedLocalState,
} from "../lib/hostedSession";
import { ErrorBlock, LoadingBlock } from "./Feedback";

export function HostedBoundary({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const info = useQuery({
    queryKey: hostedInfoKey,
    queryFn: async () => {
      const value = await hostedApi.info();
      configureHostedSession(value.hosted, value.csrfToken);
      return value;
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const me = useQuery({
    queryKey: hostedMeKey,
    queryFn: async () => {
      const value = await hostedApi.me();
      configureHostedSession(true, value.csrfToken);
      resetHostedLocalState(value.user.id);
      return value;
    },
    enabled: info.data?.hosted === true,
    retry: false,
    staleTime: 30_000,
    refetchInterval: info.data?.hosted ? 60_000 : false,
  });
  useEffect(() => {
    const expired = () => {
      client.removeQueries({
        predicate: (query) =>
          query.queryKey[0] !== "hosted" ||
          (query.queryKey[1] !== "info" && query.queryKey[1] !== "me"),
      });
      void client.resetQueries({ queryKey: hostedMeKey });
    };
    window.addEventListener(HOSTED_SESSION_EXPIRED, expired);
    return () => window.removeEventListener(HOSTED_SESSION_EXPIRED, expired);
  }, [client]);
  const acceptSession = (session: HostedMe) => {
    client.removeQueries({
      predicate: (query) =>
        query.queryKey[0] !== "hosted" ||
        (query.queryKey[1] !== "info" && query.queryKey[1] !== "me"),
    });
    resetHostedLocalState(session.user.id);
    configureHostedSession(true, session.csrfToken);
    client.setQueryData(hostedMeKey, session);
    void client.invalidateQueries({ queryKey: hostedInfoKey });
  };
  const logout = async () => {
    await hostedApi.logout();
    resetHostedLocalState();
    client.removeQueries({
      predicate: (query) =>
        query.queryKey[0] !== "hosted" ||
        (query.queryKey[1] !== "info" && query.queryKey[1] !== "me"),
    });
    await client.resetQueries({ queryKey: hostedMeKey });
  };
  if (info.isPending)
    return <LoadingBlock label="正在连接 Dearvale…" fullPage />;
  if (info.error && (!info.data || !isTransientSessionError(info.error)))
    return (
      <div className="hosted-auth">
        <ErrorBlock
          error={info.error}
          action={
            <button className="button" onClick={() => void info.refetch()}>
              重新连接
            </button>
          }
        />
      </div>
    );
  if (!info.data?.hosted) return children;
  if (me.isPending) return <LoadingBlock label="正在验证账号…" fullPage />;
  if (me.error instanceof ApiError && me.error.status === 401)
    return <HostedAuth info={info.data} onAuthenticated={acceptSession} />;
  if (me.error && (!me.data || !isTransientSessionError(me.error)))
    return (
      <div className="hosted-auth">
        <ErrorBlock
          error={me.error}
          action={
            <button className="button" onClick={() => void me.refetch()}>
              重新验证
            </button>
          }
        />
        <button className="text-button" onClick={() => void logout()}>
          退出当前账号
        </button>
      </div>
    );
  if (!me.data)
    return <HostedAuth info={info.data} onAuthenticated={acceptSession} />;
  if (me.data.user.mustChangePassword)
    return <PasswordChange required onSaved={acceptSession} />;
  if (info.data.surface === "admin" && me.data.user.role !== "admin")
    return (
      <div className="hosted-auth">
        <h1>此入口仅供管理员使用</h1>
        <button className="button" onClick={() => void logout()}>
          退出账号
        </button>
      </div>
    );
  return (
    <HostedContext.Provider
      value={{
        info: info.data,
        session: me.data,
        refresh: () => client.invalidateQueries({ queryKey: hostedMeKey }),
        logout,
      }}
    >
      {children}
      {info.error || me.error ? (
        <div className="hosted-connection-notice" role="status">
          <span>连接暂时中断，正在保留当前页面和输入。</span>
          <button
            className="text-button"
            disabled={info.isFetching || me.isFetching}
            onClick={() => {
              if (info.error) void info.refetch();
              if (me.error) void me.refetch();
            }}
          >
            重新连接
          </button>
        </div>
      ) : null}
    </HostedContext.Provider>
  );
}

function isTransientSessionError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

function HostedAuth({
  info,
  onAuthenticated,
}: {
  info: HostedInfo;
  onAuthenticated: (session: HostedMe) => void;
}) {
  const bootstrap = info.surface === "admin" && info.bootstrapRequired === true;
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const auth = useMutation({
    mutationFn: async () => {
      const value = bootstrap
        ? await hostedApi.bootstrap({ username: username.trim(), password })
        : register
          ? await hostedApi.register({
              username: username.trim(),
              password,
              inviteCode: inviteCode.trim(),
            })
          : await hostedApi.login({ username: username.trim(), password });
      if (value.csrfToken) configureHostedSession(true, value.csrfToken);
      return value.user && value.wallet ? value : hostedApi.me();
    },
    onSuccess: (value) => {
      setPassword("");
      onAuthenticated(value);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!auth.isPending) auth.mutate();
  };
  return (
    <div className="hosted-auth">
      <div className="hosted-auth__card">
        <div className="hosted-auth__brand">
          <Sprout size={30} />
          <span>Dearvale</span>
        </div>
        <p className="hosted-eyebrow">
          {info.surface === "admin" ? "测试管理控制台" : "朋友测试计划"}
        </p>
        <h1>
          {bootstrap
            ? "创建管理员账号"
            : register
              ? "让故事从这里开始"
              : "欢迎回来"}
        </h1>
        <p className="hosted-muted">
          {bootstrap
            ? "这是本机管理入口的首次设置。请为管理员设置独立的用户名和密码。"
            : register
              ? "使用朋友提供的邀请码，创建你的专属账号。"
              : info.surface === "admin"
                ? "登录后管理测试账号、模型与研究数据。"
                : "登录后，继续与你的角色相遇。"}
        </p>
        <form className="hosted-form" onSubmit={submit}>
          <label className="field">
            用户名
            <input
              autoComplete="username"
              required
              maxLength={64}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="field">
            密码
            <input
              type="password"
              autoComplete={
                register || bootstrap ? "new-password" : "current-password"
              }
              required
              minLength={register || bootstrap ? 10 : 1}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {register ? (
            <>
              <label className="field">
                邀请码
                <input
                  autoComplete="off"
                  required
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                />
              </label>
              <p className="hosted-muted hosted-small">
                测试积分由管理员分配；发送请求会按所选模型的价格扣除积分。密码请至少使用
                10 个字符。
              </p>
            </>
          ) : null}
          {auth.error ? <ErrorBlock error={auth.error} /> : null}
          <button
            className="button button--primary"
            type="submit"
            disabled={auth.isPending}
          >
            <LogIn size={18} />
            {auth.isPending
              ? "正在验证…"
              : bootstrap
                ? "创建管理员并进入"
                : register
                  ? "注册并进入"
                  : "登录"}
          </button>
        </form>
        {info.surface !== "admin" && info.registrationEnabled !== false ? (
          <button
            className="text-button hosted-auth__switch"
            type="button"
            disabled={auth.isPending}
            onClick={() => {
              setRegister((value) => !value);
              auth.reset();
              setPassword("");
            }}
          >
            {register ? "已有账号，返回登录" : "收到邀请码？创建账号"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function PasswordChange({
  required = false,
  onSaved,
}: {
  required?: boolean;
  onSaved: (session: HostedMe) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const mutation = useMutation({
    mutationFn: async () => {
      const value = await hostedApi.password({ currentPassword, newPassword });
      if (value?.csrfToken) configureHostedSession(true, value.csrfToken);
      return value?.user ? value : hostedApi.me();
    },
    onSuccess: (value) => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      onSaved(value);
    },
  });
  return (
    <section className={required ? "hosted-auth" : "hosted-panel"}>
      <form
        className={required ? "hosted-auth__card hosted-form" : "hosted-form"}
        onSubmit={(event) => {
          event.preventDefault();
          if (newPassword !== confirm) {
            setMismatch(true);
            return;
          }
          setMismatch(false);
          mutation.mutate();
        }}
      >
        <h2>
          <LockKeyhole size={22} /> {required ? "设置你的新密码" : "修改密码"}
        </h2>
        {required ? (
          <p className="hosted-muted">
            当前为初始或重置密码。设置新密码后即可继续使用。
          </p>
        ) : null}
        <label className="field">
          当前密码
          <input
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label className="field">
          新密码
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
            maxLength={128}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <label className="field">
          再次输入新密码
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        {mismatch ? (
          <p className="hosted-error" role="alert">
            两次输入的新密码不一致。
          </p>
        ) : null}
        {mutation.error ? <ErrorBlock error={mutation.error} /> : null}
        {mutation.isSuccess ? <p role="status">密码已更新。</p> : null}
        <button
          className="button button--primary"
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "正在保存…" : "保存新密码"}
        </button>
      </form>
    </section>
  );
}
