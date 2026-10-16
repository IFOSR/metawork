/** Validate the encoded size and PNG header before asking Electron to decode pixels. */
export function chartImagePayload(title: unknown, value: unknown): { name: string; bytes: Buffer } {
  if (typeof title !== 'string' || title.length > 160 || !title.trim()
    || typeof value !== 'string' || value.length > 8_000_000 || !value.startsWith('data:image/png;base64,')) {
    throw new Error('图表图片格式不可用');
  }
  const encoded = value.slice('data:image/png;base64,'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('图表图片格式不可用');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('图表图片格式不可用');
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000) throw new Error('图表图片尺寸超过上限');
  const name = title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').replace(/^\.+/u, '_').slice(0, 100);
  return { name: `${name}.png`, bytes };
}
