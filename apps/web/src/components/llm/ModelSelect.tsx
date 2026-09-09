import { ChevronDown, Check, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { LlmProviderView, LlmSelection } from "@personasim/contracts";
import { sameSelection, selectionKey } from "../../lib/llmSettings";

interface Props {
  label: string;
  providers: LlmProviderView[];
  value: LlmSelection | null;
  onChange: (selection: LlmSelection | null) => void;
  disabled?: boolean;
  allowDefault?: boolean;
  defaultLabel?: string;
}

export function ModelSelect({
  label,
  providers,
  value,
  onChange,
  disabled = false,
  allowDefault = false,
  defaultLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const provider = providers.find((item) => item.id === value?.providerId);
  const selected = provider?.models.find((item) => item.id === value?.modelId);
  const caption = value
    ? `${provider?.name ?? "供应商不可用"} / ${selected?.label || value.modelId}`
    : allowDefault
      ? `跟随全局默认${defaultLabel ? ` · ${defaultLabel}` : ""}`
      : "选择模型";
  const term = search.trim().toLocaleLowerCase();
  const options: {
    key: string;
    selection: LlmSelection | null;
    label: string;
    group: string;
  }[] = [
    ...(allowDefault
      ? [{ key: "default", selection: null, label: "跟随全局默认", group: "" }]
      : []),
    ...providers.flatMap((item) =>
      item.models
        .filter((model) =>
          `${item.name} ${model.id} ${model.label ?? ""}`
            .toLocaleLowerCase()
            .includes(term),
        )
        .map((model) => ({
          key: selectionKey({ providerId: item.id, modelId: model.id }),
          selection: { providerId: item.id, modelId: model.id },
          label: model.label ? `${model.label} · ${model.id}` : model.id,
          group: item.name,
        })),
    ),
  ];
  const choose = (option: (typeof options)[number]) => {
    onChange(option.selection);
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${listId}-${active}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, listId, open]);
  return (
    <div
      className="model-select"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="model-select__trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => {
          setOpen((current) => !current);
          setSearch("");
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setSearch("");
            setActive(0);
          }
        }}
      >
        <span title={caption}>{caption}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && !disabled ? (
        <div className="model-select__popover">
          <div className="model-select__search">
            <Search size={16} aria-hidden="true" />
            <input
              autoFocus
              aria-label={`搜索${label}`}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                options[active] ? `${listId}-${active}` : undefined
              }
              placeholder="搜索供应商或模型…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setOpen(false);
                  trigger.current?.focus();
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive(
                    (index) =>
                      (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        Math.max(options.length, 1)) %
                      Math.max(options.length, 1),
                  );
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  const option = options[active];
                  if (option) choose(option);
                }
              }}
            />
          </div>
          <div
            id={listId}
            role="listbox"
            aria-label={label}
            className="model-select__options"
          >
            {options.length === 0 ? (
              <p className="model-select__empty">
                没有找到模型，请在设置中检测或手动添加。
              </p>
            ) : null}
            {options.map((option, index) => (
              <div key={option.key}>
                {option.group && options[index - 1]?.group !== option.group ? (
                  <div className="model-select__group">{option.group}</div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  id={`${listId}-${index}`}
                  aria-selected={sameSelection(value, option.selection)}
                  className={`model-select__option${active === index ? " is-active" : ""}`}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(option)}
                >
                  <span>{option.label}</span>
                  {sameSelection(value, option.selection) ? (
                    <Check size={15} aria-hidden="true" />
                  ) : null}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
