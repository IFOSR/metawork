import { describe, expect, it } from 'vitest';
import {
  PRODUCT_ENVIRONMENT,
  resolveProductEnvironment,
} from '../../src/installation/product-environment.js';

describe('product environment compatibility', () => {
  it('uses the canonical MetaWork value when it is configured alone', () => {
    expect(resolveProductEnvironment(
      { METAWORK_INSTALL_ROOT: ' /srv/metawork ' },
      ...PRODUCT_ENVIRONMENT.installRoot,
    )).toBe('/srv/metawork');
  });

  it('accepts the AnyFusion compatibility value when it is configured alone', () => {
    expect(resolveProductEnvironment(
      { ANYFUSION_INSTALL_ROOT: '/srv/anyfusion' },
      ...PRODUCT_ENVIRONMENT.installRoot,
    )).toBe('/srv/anyfusion');
  });

  it('accepts identical canonical and compatibility values', () => {
    expect(resolveProductEnvironment(
      {
        METAWORK_PROVIDER_URL: 'https://provider.example/v1',
        ANYFUSION_PROVIDER_URL: ' https://provider.example/v1 ',
      },
      ...PRODUCT_ENVIRONMENT.providerUrl,
    )).toBe('https://provider.example/v1');
  });

  it('fails closed when canonical and compatibility values conflict', () => {
    expect(() => resolveProductEnvironment(
      {
        METAWORK_PROVIDER_MODEL: 'model-a',
        ANYFUSION_PROVIDER_MODEL: 'model-b',
      },
      ...PRODUCT_ENVIRONMENT.providerModel,
    )).toThrow(
      'METAWORK_PROVIDER_MODEL conflicts with compatibility variable ANYFUSION_PROVIDER_MODEL',
    );
  });

  it('treats empty values as absent without mutating the environment', () => {
    const env = {
      METAWORK_CONFIG_HOME: ' ',
      ANYFUSION_CONFIG_HOME: '/home/test/.config/anyfusion',
    };

    expect(resolveProductEnvironment(
      env,
      ...PRODUCT_ENVIRONMENT.configHome,
    )).toBe('/home/test/.config/anyfusion');
    expect(env).toEqual({
      METAWORK_CONFIG_HOME: ' ',
      ANYFUSION_CONFIG_HOME: '/home/test/.config/anyfusion',
    });
  });

  it.each([
    PRODUCT_ENVIRONMENT.providerKey,
    PRODUCT_ENVIRONMENT.providerRegion,
    PRODUCT_ENVIRONMENT.secretStore,
  ])('supports the %s and %s variable pair', (canonicalName, compatibilityName) => {
    expect(resolveProductEnvironment(
      { [canonicalName]: 'configured-value' },
      canonicalName,
      compatibilityName,
    )).toBe('configured-value');
  });
});
