import { Check, Plus, Trash2 } from "lucide-react";

export function EditorSectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="editor-section-title">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <span className="validation-status">
        <Check size={15} /> 表单编辑
      </span>
    </div>
  );
}

export function RangeSetting({
  label,
  value,
  onChange,
  onFocus,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onFocus?: () => void;
}) {
  return (
    <label className="range-setting">
      <span>{label}</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value}
        onFocus={onFocus}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{Math.round(value * 100)}%</output>
    </label>
  );
}

export function NumberSetting({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
  onFocus,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  onChange: (value: number) => void;
  onFocus?: () => void;
}) {
  return (
    <label className="field editor-field number-setting">
      <span>{label}</span>
      <span>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onFocus={onFocus}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            if (Number.isFinite(next))
              onChange(Math.min(max, Math.max(min, next)));
          }}
        />
        <small>{suffix}</small>
      </span>
    </label>
  );
}

export function EditableStringList({
  title,
  description,
  values,
  placeholder,
  multiline = false,
  onChange,
  onSelect,
}: {
  title: string;
  description?: string;
  values: string[];
  placeholder: string;
  multiline?: boolean;
  onChange: (values: string[]) => void;
  onSelect?: (index: number) => void;
}) {
  return (
    <section className="editable-string-list">
      <div className="editable-string-list__heading">
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        <span>{values.length}</span>
      </div>
      <div className="editable-string-list__items">
        {values.map((value, index) => (
          <div key={`${title}-${index}`}>
            {multiline ? (
              <textarea
                rows={3}
                aria-label={`${title} ${index + 1}`}
                value={value}
                onFocus={() => onSelect?.(index)}
                onChange={(event) =>
                  onChange(
                    values.map((item, itemIndex) =>
                      itemIndex === index ? event.target.value : item,
                    ),
                  )
                }
              />
            ) : (
              <input
                aria-label={`${title} ${index + 1}`}
                value={value}
                onFocus={() => onSelect?.(index)}
                onChange={(event) =>
                  onChange(
                    values.map((item, itemIndex) =>
                      itemIndex === index ? event.target.value : item,
                    ),
                  )
                }
              />
            )}
            <button
              type="button"
              aria-label={`删除${title} ${index + 1}`}
              onClick={() =>
                onChange(values.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="text-button editable-string-list__add"
        type="button"
        onClick={() => onChange([...values, placeholder])}
      >
        <Plus size={14} /> {placeholder}
      </button>
    </section>
  );
}
