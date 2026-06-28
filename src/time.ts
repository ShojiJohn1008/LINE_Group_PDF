// All dates/folders/usage windows are computed in Japan time (Asia/Tokyo).
// Do not reintroduce UTC getMonth()-style code.

export function getJapanDateParts(date: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return {
    year: parts.find((part) => part.type === "year")?.value || "0000",
    month: parts.find((part) => part.type === "month")?.value || "00",
    day: parts.find((part) => part.type === "day")?.value || "00"
  };
}

export function formatDateForFile(date: Date): string {
  const parts = getJapanDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatYearMonth(date: Date): string {
  const parts = getJapanDateParts(date);
  return `${parts.year}-${parts.month}`;
}
