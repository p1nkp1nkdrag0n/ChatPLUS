import type { HostedUser } from "../../api/hosted";

export function HostedAccountIdentity({ user }: { user: HostedUser }) {
  return (
    <div className="hosted-account-identity">
      <label className="field">
        完整账号（用于登录）
        <input
          readOnly
          autoComplete="off"
          value={user.accountName}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <p className="hosted-muted hosted-small">
        # 后的六位编号用于区分同名账号，请在登录时一并填写。
      </p>
      <dl>
        <dt>用户名（角色对你的称呼）</dt>
        <dd>{user.username}</dd>
      </dl>
      <p className="hosted-muted hosted-small">
        角色会用用户名来称呼你，例如“圆圆”。角色会根据对话自然使用你的名字，不必每次回复都称呼你，账号编号不会作为称呼。
      </p>
    </div>
  );
}
