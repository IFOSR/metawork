import { describe, expect, it } from 'vitest';
import { chartImagePayload } from '../main/chart-image.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=';
describe('native chart image save boundary', () => {
  it('accepts bounded PNG pixels and sanitizes the default name', () => {
    expect(chartImagePayload('../收入/趋势', `data:image/png;base64,${png}`).name).toBe('__收入_趋势.png');
  });
  it.each(['data:image/svg+xml,<svg/>', 'https://example.com/chart.png', 'file:///etc/passwd', 'data:image/png;base64,garbage'])('rejects non-PNG content %s', value => {
    expect(() => chartImagePayload('图表', value)).toThrow();
  });
  it('rejects image bombs and oversized payloads before native decoding', () => {
    const bomb = Buffer.from(png, 'base64'); bomb.writeUInt32BE(100000, 16);
    expect(() => chartImagePayload('图表', `data:image/png;base64,${bomb.toString('base64')}`)).toThrow('尺寸');
    expect(() => chartImagePayload('图表', 'x'.repeat(8_000_001))).toThrow();
    expect(() => chartImagePayload('x'.repeat(161), `data:image/png;base64,${png}`)).toThrow();
  });
});
