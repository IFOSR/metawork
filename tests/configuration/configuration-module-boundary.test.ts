import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

type SourceFile = Readonly<{
  path: string;
  source: string;
}>;

function readSource(path: string): string {
  return readFileSync(resolve(projectRoot, path), 'utf-8');
}

function readSourceFilesUnder(directory: string): SourceFile[] {
  const absoluteDirectory = resolve(projectRoot, directory);

  if (!existsSync(absoluteDirectory)) {
    return [];
  }

  return readdirSync(absoluteDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${directory}/${entry.name}`;

      if (entry.isDirectory()) {
        return readSourceFilesUnder(path);
      }

      return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')
        ? [{ path, source: readSource(path) }]
        : [];
    });
}

function readImportSpecifiers(files: SourceFile[]): string[] {
  return files.flatMap(({ source }) =>
    [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]),
  );
}

function importsModule(specifier: string, module: string): boolean {
  return specifier.split('/').includes(module);
}

describe('configuration module architecture boundaries', () => {
  it('exposes only type-only ports without concrete runtime dependencies', () => {
    expect(existsSync(resolve(projectRoot, 'src/configuration/index.ts'))).toBe(true);

    const configurationSource = readSource('src/configuration/index.ts');

    expect(configurationSource).not.toMatch(/^\s*import\s/m);
    expect(configurationSource).not.toMatch(/from ['"][^'"]*(kernel|execution|storage)/);
    expect(configurationSource).not.toMatch(/\b(class|function|const|let|var)\b/);
    expect(configurationSource).toMatch(/export\s+type\s+ConfigurationServicePort\b/);
    expect(configurationSource).toMatch(/export\s+type\s+PlannerConfigurationView\b/);
    expect(configurationSource).toMatch(/export\s+type\s+KernelConfigurationView\b/);
    expect(configurationSource).toMatch(/export\s+type\s+RuntimePrivateConfigurationBinding\b/);
  });

  it('keeps the configuration control plane at the application-shell boundary', () => {
    const configurationFiles = readSourceFilesUnder('src/configuration');
    const planningFiles = readSourceFilesUnder('src/planning');
    const kernelFiles = readSourceFilesUnder('src/kernel');
    const gatewayFiles = readSourceFilesUnder('src/gateway');
    const configurationImports = readImportSpecifiers(configurationFiles);
    const kernelImports = readImportSpecifiers(kernelFiles);
    const gatewayImports = readImportSpecifiers(gatewayFiles);

    const configurationImportsKernel = configurationImports.some((specifier) =>
      importsModule(specifier, 'kernel'));
    const configurationImportsRuntime = configurationImports.some((specifier) =>
      importsModule(specifier, 'execution'));
    const planningImportsRuntimePrivateBinding = planningFiles.some(({ source }) =>
      /\bRuntimePrivateConfigurationBinding\b/.test(source));
    const kernelImportsConcreteConfigurationRepository = kernelImports.some((specifier) =>
      importsModule(specifier, 'configuration') && /repository/.test(specifier));
    const gatewayImportsStorageAdapter = gatewayImports.some((specifier) =>
      importsModule(specifier, 'storage'));

    expect(configurationImportsKernel).toBe(false);
    expect(configurationImportsRuntime).toBe(false);
    expect(planningImportsRuntimePrivateBinding).toBe(false);
    expect(kernelImportsConcreteConfigurationRepository).toBe(false);
    expect(gatewayImportsStorageAdapter).toBe(false);
  });
});
