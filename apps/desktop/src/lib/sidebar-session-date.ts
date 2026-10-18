const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatSessionLastReplyDate(
  value: string | undefined,
  now = new Date(),
  locale?: string,
): string {
  if (!value) return "";

  const timestamp = Date.parse(value);
  const currentTime = now.getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(currentTime)) return "";

  let formatter: Intl.RelativeTimeFormat;
  try {
    formatter = new Intl.RelativeTimeFormat(locale || undefined, {
      numeric: "always",
    });
  } catch {
    formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  }

  const chinese = formatter.resolvedOptions().locale.startsWith("zh");
  const elapsed = Math.max(0, currentTime - timestamp);
  const minutesAgo = Math.floor(elapsed / MINUTE_MS);
  if (minutesAgo < 1) return chinese ? "刚刚" : "Just now";
  if (minutesAgo < 30) return formatter.format(-minutesAgo, "minute");
  if (minutesAgo < 60) return chinese ? "半小时前" : "Half an hour ago";

  const hoursAgo = Math.floor(elapsed / HOUR_MS);
  if (hoursAgo < 24) return formatter.format(-hoursAgo, "hour");

  const daysAgo = Math.floor(elapsed / DAY_MS);
  if (daysAgo <= 30) return formatter.format(-daysAgo, "day");
  return chinese ? "很久以前" : "A long time ago";
}
