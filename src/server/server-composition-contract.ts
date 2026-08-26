export interface ServerEndpoints {
  readonly unixSocketPath: string;
  readonly webOrigin: string;
}

export interface ServerComposition {
  startListeners(): Promise<ServerEndpoints>;
  stopListeners(): Promise<void>;
  drain(): Promise<void>;
  stopRuntime(): Promise<void>;
}

export function createServerComposition(deps: ServerComposition): ServerComposition {
  return {
    startListeners: () => deps.startListeners(),
    stopListeners: () => deps.stopListeners(),
    drain: () => deps.drain(),
    stopRuntime: () => deps.stopRuntime(),
  };
}
