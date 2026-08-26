export const PRODUCT_ENVIRONMENT = {
  installRoot: ['METAWORK_INSTALL_ROOT', 'ANYFUSION_INSTALL_ROOT'],
  providerKey: ['METAWORK_PROVIDER_KEY', 'ANYFUSION_PROVIDER_KEY'],
  providerUrl: ['METAWORK_PROVIDER_URL', 'ANYFUSION_PROVIDER_URL'],
  providerModel: ['METAWORK_PROVIDER_MODEL', 'ANYFUSION_PROVIDER_MODEL'],
  providerRegion: ['METAWORK_PROVIDER_REGION', 'ANYFUSION_PROVIDER_REGION'],
  secretStore: ['METAWORK_SECRET_STORE', 'ANYFUSION_SECRET_STORE'],
  configHome: ['METAWORK_CONFIG_HOME', 'ANYFUSION_CONFIG_HOME'],
} as const;

export function resolveProductEnvironment(
  env: NodeJS.ProcessEnv,
  canonicalName: string,
  compatibilityName: string,
): string | undefined {
  const canonicalValue = normalizeEnvironmentValue(env[canonicalName]);
  const compatibilityValue = normalizeEnvironmentValue(env[compatibilityName]);
  if (
    canonicalValue !== undefined
    && compatibilityValue !== undefined
    && canonicalValue !== compatibilityValue
  ) {
    throw new Error(
      `${canonicalName} conflicts with compatibility variable ${compatibilityName}`,
    );
  }
  return canonicalValue ?? compatibilityValue;
}

function normalizeEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
