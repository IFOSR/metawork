export function truncateText(value: string, limit: number): string {
  if (limit <= 0) return '';
  if (value.length <= limit) return value;

  let end = limit - 1;
  const finalCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  if (isHighSurrogate(finalCodeUnit) && isLowSurrogate(nextCodeUnit)) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}
