import {
  LETTER_DELIVERY_METHODS,
  type LetterDeliveryMethod,
} from "@personasim/contracts";
import { AtSign, Check, Mail, Send, Truck } from "lucide-react";
import "../../styles/letter-delivery.css";

const DELIVERY_ICONS = {
  standard: Mail,
  express: Truck,
  priority: Send,
  email: AtSign,
};
const DELIVERY_OPTIONS = Object.entries(LETTER_DELIVERY_METHODS) as Array<
  [LetterDeliveryMethod, (typeof LETTER_DELIVERY_METHODS)[LetterDeliveryMethod]]
>;

export function LetterDeliverySelector({
  value,
  onChange,
  disabled = false,
}: {
  value: LetterDeliveryMethod;
  onChange: (method: LetterDeliveryMethod) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="letter-delivery" disabled={disabled}>
      <legend>递送方式</legend>
      <div className="letter-delivery__options">
        {DELIVERY_OPTIONS.map(([method, option]) => {
          const Icon = DELIVERY_ICONS[method];
          return (
            <label className="letter-delivery__option" key={method}>
              <input
                type="radio"
                name="letter-delivery-method"
                value={method}
                checked={value === method}
                onChange={() => onChange(method)}
              />
              <span className="letter-delivery__card">
                <span className="letter-delivery__name">
                  <Icon size={17} aria-hidden="true" />
                  <strong>{option.label}</strong>
                  {value === method ? (
                    <Check
                      className="letter-delivery__check"
                      size={14}
                      aria-hidden="true"
                    />
                  ) : null}
                </span>
                <span className="letter-delivery__duration">
                  {method === "email"
                    ? "即时送达 · 即时回信"
                    : `${option.days} 天后抵达`}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="letter-delivery__hint">
        {value === "email"
          ? "应用内电子邮件，无需真实邮箱。发送后立即开始生成回信，完成后即可在书信页阅读。"
          : "从封缄寄出时起，按收信人当地日期计算。"}
      </p>
    </fieldset>
  );
}
