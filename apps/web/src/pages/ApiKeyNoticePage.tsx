import { useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, KeyRound, Leaf } from "lucide-react";
import { useHosted } from "../hooks/useHosted";
import { apiKeyNoticeOrigin } from "../lib/apiKeyNotice";

export default function ApiKeyNoticePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const hosted = useHosted();
  const origin = apiKeyNoticeOrigin(location.search, Boolean(hosted));
  const previous = `/${origin}`;
  useEffect(() => {
    document.title = "填写 API Key 前 · Dearvale";
  }, []);
  return (
    <main className="model-onboarding">
      <Link className="model-onboarding__brand" to={previous} replace>
        Dearvale <Leaf size={19} aria-hidden="true" />
      </Link>
      <section
        className="model-onboarding__panel api-key-notice"
        aria-labelledby="api-key-notice-title"
      >
        <KeyRound size={30} aria-hidden="true" />
        <h1 id="api-key-notice-title">填写自己的 API Key 前</h1>
        <p className="api-key-notice__warning">
          请您明确自己在做什么时再进行下一步。
        </p>
        <div className="api-key-notice__actions">
          <Link className="button button--secondary" to={previous} replace>
            <ArrowLeft size={17} aria-hidden="true" /> 返回上一步
          </Link>
          <button
            className="button button--primary"
            onClick={() =>
              navigate(
                origin === "setup"
                  ? previous
                  : `${previous}?provider=new#my-providers`,
                { replace: true, state: { apiKeyNoticeAccepted: origin } },
              )
            }
          >
            我已明确，继续填写 <ArrowRight size={17} aria-hidden="true" />
          </button>
        </div>
      </section>
    </main>
  );
}
