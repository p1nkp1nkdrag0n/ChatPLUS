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
import { HostedAccountIdentity } from "./hosted/HostedAccountIdentity";

export function HostedBoundary({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [createdAccount, setCreatedAccount] = useState<HostedMe>();
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
    setCreatedAccount(undefined);
    setCreatingAccount(false);
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
  const auth = info.data ? (
    <HostedAuth
      info={info.data}
      onAuthenticated={acceptSession}
      onCreatingAccount={setCreatingAccount}
      onRegistered={(session) => {
        setCreatedAccount(session);
        setCreatingAccount(false);
      }}
    />
  ) : null;
  // Account creation sets the session cookie before the response arrives. Keep
  // background /me refreshes from skipping the new account's save reminder.
  if (createdAccount)
    return (
      <div className="hosted-auth">
        <div className="hosted-auth__card hosted-form">
          <div className="hosted-auth__brand">
            <Sprout size={30} />
            <span>Dearvale</span>
          </div>
          <h1>账号创建成功</h1>
          <p className="hosted-muted">
            请保存下面的完整账号。下次登录时，请一起输入用户名、# 和六位编号。
          </p>
          <HostedAccountIdentity user={createdAccount.user} />
          <button
            className="button button--primary"
            onClick={() => acceptSession(createdAccount)}
          >
            我已保存账号，进入 Dearvale
          </button>
        </div>
      </div>
    );
  if (creatingAccount) return auth;
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
  if (me.error instanceof ApiError && me.error.status === 401) return auth;
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
  if (!me.data) return auth;
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
  onCreatingAccount,
  onRegistered,
}: {
  info: HostedInfo;
  onAuthenticated: (session: HostedMe) => void;
  onCreatingAccount: (pending: boolean) => void;
  onRegistered: (session: HostedMe) => void;
}) {
  const bootstrap = info.surface === "admin" && info.bootstrapRequired === true;
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [confirmedAdult, setConfirmedAdult] = useState(false);
  const auth = useMutation({
    mutationFn: async () => {
      const value = bootstrap
        ? await hostedApi.bootstrap({ username: username.trim(), password })
        : register
          ? await hostedApi.register({
              username: username.trim(),
              password,
              inviteCode: inviteCode.trim(),
              confirmedAdult,
            })
          : await hostedApi.login({ username: username.trim(), password });
      if (value.csrfToken) configureHostedSession(true, value.csrfToken);
      return value.user && value.wallet ? value : hostedApi.me();
    },
    onSuccess: (value) => {
      setPassword("");
      if (register || bootstrap) onRegistered(value);
      else onAuthenticated(value);
    },
    onError: () => onCreatingAccount(false),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (register && !confirmedAdult) return;
    if (!auth.isPending) {
      if (register || bootstrap) onCreatingAccount(true);
      auth.mutate();
    }
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
            {register || bootstrap ? "用户名（角色对你的称呼）" : "完整账号"}
            <input
              autoComplete="username"
              aria-describedby="hosted-username-help"
              placeholder={
                register || bootstrap ? "例如：圆圆" : "例如：圆圆#123456"
              }
              required
              minLength={2}
              maxLength={register || bootstrap ? 32 : 39}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <p
            id="hosted-username-help"
            className="hosted-muted hosted-small hosted-field-help"
          >
            {register || bootstrap
              ? "角色会用这个用户名来称呼你，例如填写“圆圆”，角色就会称呼你“圆圆”；会根据对话自然使用，不必每次回复都叫名字。用户名可以重复，创建账号后会自动添加 # 和随机六位编号，用于区分账号。"
              : "请输入创建账号时保存的完整账号（用户名#六位编号）。已有的旧账号也可以继续使用原用户名登录。"}
          </p>
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
              <label className="hosted-checkbox">
                <input
                  type="checkbox"
                  name="confirmedAdult"
                  required
                  checked={confirmedAdult}
                  disabled={auth.isPending}
                  aria-describedby="hosted-age-requirement"
                  onChange={(event) => setConfirmedAdult(event.target.checked)}
                />
                <span>我已年满18周岁</span>
              </label>
              <p
                id="hosted-age-requirement"
                className="hosted-muted hosted-small hosted-field-help"
              >
                仅限年满18周岁的用户注册，请如实确认。
              </p>
            </>
          ) : null}
          {auth.error ? <ErrorBlock error={auth.error} /> : null}
          <button
            className="button button--primary"
            type="submit"
            disabled={auth.isPending || (register && !confirmedAdult)}
          >
            <LogIn size={18} />
            {auth.isPending
              ? "正在验证…"
              : bootstrap
                ? "创建管理员账号"
                : register
                  ? "创建账号"
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
              setConfirmedAdult(false);
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
