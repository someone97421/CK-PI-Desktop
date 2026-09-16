/** 日期版本的 SemVer 编码为 YYMM.DDHH.MMSS；界面还原为 YYYYMMDD-HHMMSS。 */
export function displayAppVersion(version: string | undefined): string {
  if (!version) return "";
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(version);
  if (!match) return version;
  const [ym, dh, ms] = match.slice(1).map((part) => part.padStart(4, "0"));
  const month = Number(ym.slice(2));
  const day = Number(dh.slice(0, 2));
  const hour = Number(dh.slice(2));
  const minute = Number(ms.slice(0, 2));
  const second = Number(ms.slice(2));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return version;
  return `20${ym}${dh.slice(0, 2)}-${dh.slice(2)}${ms}`;
}
