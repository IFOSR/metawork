export type GatewaySurface = 'web' | 'feishu' | 'tui' | 'local' | 'unknown';

/** Internal live-delivery context. Never serialize this into a public event. */
export interface GatewayTurnOrigin {
  readonly connectionId: string;
  readonly surface: GatewaySurface;
}
