// Sealed into Main by the native builder; never supplied by payload metadata.
declare const METAWORK_INTERNAL_WINDOWS_BUILD: boolean;
const internalWindowsBuild = typeof METAWORK_INTERNAL_WINDOWS_BUILD !== 'undefined'
  && METAWORK_INTERNAL_WINDOWS_BUILD;

export function allowDevelopmentPayload(descriptorDevelopment: boolean, platform = process.platform): boolean {
  return platform === 'win32' ? internalWindowsBuild : descriptorDevelopment;
}
