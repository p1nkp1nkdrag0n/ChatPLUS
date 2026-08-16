export function StatusMeter({
  label,
  value,
  tone = "green",
}: {
  label: string;
  value: number;
  tone?: "green" | "blue" | "orange" | "sky";
}) {
  const normalized = Math.max(0, Math.min(1, value));
  return (
    <div className="status-meter">
      <span>{label}</span>
      <span className="status-meter__track" aria-hidden="true">
        <span
          className={`status-meter__fill status-meter__fill--${tone}`}
          style={{ width: `${Math.round(normalized * 100)}%` }}
        />
      </span>
      <strong>{Math.round(normalized * 100)}%</strong>
    </div>
  );
}
