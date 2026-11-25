#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const STAGE_DIR = join(AGENT_DIR, '.pkg-stage');
const RELEASE_DIR = join(AGENT_DIR, 'release');

const SCRIPT_FILES = [
  'index.js',
  'commands.js',
  'config.js',
  'dtc-scan.js',
  'health.js',
  'modem.js',
  'mqtt.js',
  'obd.js',
  'peripherals.js',
  'telemetry.js',
];

const ASSET_FILES = [
  'carlink-device.example.json',
  'carlink-telemetry.service',
];

/**
 * Convert a top-level ESM agent module into CommonJS so pkg@5.8.1 loads it
 * without throwing ERR_REQUIRE_ESM at binary startup.
 */
export function transpileEsmToCjs(source) {
  const exportedNames = [];
  let code = source;

  // 1. Convert multi-line or single-line named imports: import { a, b as c } from 'mod';
  code = code.replace(
    /^import\s*\{([\s\S]*?)\}\s*from\s*(['"][^'"]+['"])\s*;?/gm,
    (_m, specifiers, modPath) => {
      const normalized = specifiers.replace(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g, '$1: $2');
      return `const {${normalized}} = require(${modPath});`;
    },
  );

  // 2. Convert default imports: import name from 'mod';
  code = code.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"][^'"]+['"])\s*;?/gm,
    (_m, localName, modPath) => `const ${localName} = require(${modPath});`,
  );

  // 3. Remove createRequire(import.meta.url) shadow; CJS already has native require()
  code = code.replace(/^\s*const\s+require\s*=\s*createRequire\(import\.meta\.url\)\s*;?\s*$/gm, '// CJS native require');
  code = code.replace(/fileURLToPath\(import\.meta\.url\)/g, '__filename');

  // 4. Convert top-level export declarations and collect exported symbol names
  code = code.replace(
    /^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    (_m, asyncKw, name) => {
      exportedNames.push(name);
      return `${asyncKw || ''}function ${name}`;
    },
  );
  code = code.replace(
    /^export\s+class\s+([A-Za-z_$][\w$]*)/gm,
    (_m, name) => {
      exportedNames.push(name);
      return `class ${name}`;
    },
  );
  code = code.replace(
    /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm,
    (_m, name) => {
      exportedNames.push(name);
      return `const ${name} =`;
    },
  );

  if (exportedNames.length > 0) {
    code += `\nObject.assign(exports, { ${exportedNames.join(', ')} });\n`;
  }

  return code;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function build() {
  const rawPkg = JSON.parse(readFileSync(join(AGENT_DIR, 'package.json'), 'utf8'));

  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });
  mkdirSync(RELEASE_DIR, { recursive: true });

  try {
    for (const file of SCRIPT_FILES) {
      const esm = readFileSync(join(AGENT_DIR, file), 'utf8');
      writeFileSync(join(STAGE_DIR, file), transpileEsmToCjs(esm));
    }

    for (const asset of ASSET_FILES) {
      const src = join(AGENT_DIR, asset);
      if (existsSync(src)) copyFileSync(src, join(STAGE_DIR, asset));
    }

    const stagePkg = {
      name: rawPkg.name,
      version: rawPkg.version,
      private: true,
      type: 'commonjs',
      bin: 'index.js',
      main: 'index.js',
      dependencies: rawPkg.dependencies,
      pkg: {
        scripts: SCRIPT_FILES.filter((f) => f !== 'index.js'),
        assets: ['package.json', ...ASSET_FILES],
        targets: rawPkg.pkg?.targets ?? ['node18-linux-arm64'],
      },
    };
    writeFileSync(join(STAGE_DIR, 'package.json'), `${JSON.stringify(stagePkg, null, 2)}\n`);

    const nodeModulesSrc = join(AGENT_DIR, 'node_modules');
    if (existsSync(nodeModulesSrc)) {
      symlinkSync(nodeModulesSrc, join(STAGE_DIR, 'node_modules'), 'dir');
    }

    // Smoke-check the transpiled CommonJS entrypoint under plain Node CJS before packaging
    execFileSync(process.execPath, [join(STAGE_DIR, 'index.js'), '--help'], {
      stdio: 'pipe',
    });

    const outBin = join(RELEASE_DIR, 'carlink-telemetry-agent');
    const outArmBin = join(RELEASE_DIR, 'carlink-telemetry-agent-linux-arm64');
    const localPkgBin = join(AGENT_DIR, 'node_modules', '.bin', 'pkg');

    if (existsSync(localPkgBin)) {
      execFileSync(
        localPkgBin,
        ['--public', '--public-packages', '*', '--no-bytecode', '-t', 'node18-linux-arm64', '-o', outBin, STAGE_DIR],
        { cwd: STAGE_DIR, stdio: 'inherit' },
      );
    } else {
      execFileSync(
        'npx',
        ['--cache', '/tmp/npm-cache', 'pkg@5.8.1', '--public', '--public-packages', '*', '--no-bytecode', '-t', 'node18-linux-arm64', '-o', outBin, STAGE_DIR],
        { cwd: STAGE_DIR, stdio: 'inherit' },
      );
    }

    copyFileSync(outBin, outArmBin);
    const sums = [
      `${sha256File(outBin)}  carlink-telemetry-agent`,
      `${sha256File(outArmBin)}  carlink-telemetry-agent-linux-arm64`,
      '',
    ].join('\n');
    writeFileSync(join(RELEASE_DIR, 'SHA256SUMS'), sums);
    console.log(`[BUILD] Packaged CommonJS binary -> ${outBin}`);
  } finally {
    rmSync(STAGE_DIR, { recursive: true, force: true });
  }
}

build();
