interface Props {
  warnings: string[];
  notices: string[];
  outlookEnabled: boolean;
  outlookAvailable: boolean;
  onSettings: () => void;
}

export function NoticeStrip({ warnings, notices, outlookEnabled, outlookAvailable, onSettings }: Props) {
  const items = [
    ...warnings.map((message) => ({ type: "warning", message })),
    ...notices.map((message) => ({ type: "notice", message })),
  ];
  if (!outlookEnabled) {
    items.unshift({ type: "notice", message: "Outlook email is disabled; Zeus will skip every email-related task." });
  } else if (!outlookAvailable) {
    items.unshift({ type: "warning", message: "The configured Outlook store is unavailable; email tasks are paused." });
  }
  if (!items.length) return null;
  const visible = items.slice(0, 3);
  return (
    <section className="notice-strip" aria-label="Zeus notices">
      <div className="notice-list">
        {visible.map((item, index) => (
          <div className={`notice-line ${item.type}`} key={`${item.type}-${index}`}>
            <span aria-hidden="true">{item.type === "warning" ? "!" : "•"}</span>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
      <button type="button" className="text-button" onClick={onSettings}>Configure</button>
    </section>
  );
}
