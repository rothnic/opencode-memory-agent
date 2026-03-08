import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} ${args.join(' ')} exited with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      rejectPromise(error);
    });
  });
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function escapeJsonEnvReference(name) {
  return `{env:${name}}`;
}

function parseProviderID(model) {
  const slash = model.indexOf('/');
  if (slash === -1) {
    throw new Error(`Model must be in provider/model format, received: ${model}`);
  }
  return model.slice(0, slash);
}

function selectApiKeySource() {
  for (const candidate of API_KEY_ENV_CANDIDATES) {
    if (process.env[candidate]?.trim()) {
      return candidate;
    }
  }
  return undefined;
}

function buildProviderConfig(providerID, apiKeyEnvName, providerBaseURL) {
  if (!apiKeyEnvName) {
    return undefined;
  }

  return {
    [providerID]: {
      options: {
        apiKey: escapeJsonEnvReference(apiKeyEnvName),
        ...(providerBaseURL ? { baseURL: escapeJsonEnvReference('OPENCODE_PROVIDER_BASE_URL') } : {})
      }
    }
  };
}

const EXPECTED_FIXTURE_SENTENCE = 'This README identifies this repository as the manual integration test fixture.';
const API_KEY_ENV_CANDIDATES = ['OPENCODE_PROVIDER_API_KEY', 'KIMI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];

async function main() {
  const repoRoot = resolve(process.cwd());
  const model = requireEnv('OPENCODE_INTEGRATION_MODEL');
  const providerID = parseProviderID(model);
  const providerBaseURL = process.env.OPENCODE_PROVIDER_BASE_URL?.trim() ?? '';
  const authJsonB64 = process.env.OPENCODE_AUTH_JSON_B64?.trim();
  const apiKeyEnvName = selectApiKeySource();
  const dryRun = process.env.OPENCODE_INTEGRATION_DRY_RUN === '1';

  if (providerID === 'github-copilot' && !authJsonB64) {
    throw new Error('The github-copilot provider requires OPENCODE_AUTH_JSON_B64 with a seeded OpenCode auth.json payload for non-interactive CI use.');
  }

  if (!apiKeyEnvName && !authJsonB64) {
    throw new Error('Set OPENCODE_PROVIDER_API_KEY, KIMI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or OPENCODE_AUTH_JSON_B64 before running the manual integration test.');
  }

  const outputDir = process.env.OPENCODE_INTEGRATION_OUTPUT_DIR?.trim();
  let scratchRoot;
  if (outputDir) {
    scratchRoot = resolve(outputDir);
    await rm(scratchRoot, { recursive: true, force: true });
    await mkdir(scratchRoot, { recursive: true });
  } else {
    scratchRoot = await mkdtemp(join(tmpdir(), 'opencode-memory-agent-integration-'));
  }
  const isolatedHome = join(scratchRoot, 'home');
  const projectRoot = join(scratchRoot, 'fixture-project');
  const logsDir = join(scratchRoot, 'logs');
  await mkdir(isolatedHome, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  if (authJsonB64) {
    const authDir = join(isolatedHome, '.local', 'share', 'opencode');
    await mkdir(authDir, { recursive: true });
    await writeFile(join(authDir, 'auth.json'), Buffer.from(authJsonB64, 'base64'));
  }

  const packResult = await run('npm', ['pack', '--pack-destination', scratchRoot], {
    cwd: repoRoot,
    env: process.env
  });
  const tarballName = packResult.stdout.trim().split('\n').filter(Boolean).at(-1);
  if (!tarballName) {
    throw new Error(`npm pack did not return a tarball name.\n${packResult.stdout}\n${packResult.stderr}`);
  }

  const tarballPath = join(scratchRoot, tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`Packed tarball was not created at ${tarballPath}`);
  }

  const projectConfig = {
    $schema: 'https://opencode.ai/config.json',
    model,
    plugin: [`file:${tarballPath}`],
    ...(apiKeyEnvName ? { provider: buildProviderConfig(providerID, apiKeyEnvName, providerBaseURL) } : {})
  };

  const pluginConfig = {
    model,
    statusToast: false,
    backfillOnStartup: false,
    consolidateOnStartup: false,
    consolidateEveryMinutes: 0
  };

  await mkdir(join(projectRoot, '.opencode', 'memory'), { recursive: true });
  await mkdir(join(projectRoot, 'docs'), { recursive: true });
  await writeFile(
    join(projectRoot, 'README.md'),
    [
      '# Integration Fixture',
      '',
      EXPECTED_FIXTURE_SENTENCE,
      '',
      'The plugin should index this file and answer questions about it through memory_query.'
    ].join('\n')
  );
  await writeFile(
    join(projectRoot, 'docs', 'notes.md'),
    [
      '# Notes',
      '',
      'This file exists so docs indexing has more than one source document.'
    ].join('\n')
  );
  await writeFile(join(projectRoot, 'opencode.json'), `${JSON.stringify(projectConfig, null, 2)}\n`);
  await writeFile(join(projectRoot, '.opencode', 'memory', 'config.json'), `${JSON.stringify(pluginConfig, null, 2)}\n`);

  const prompt = [
    'Use the opencode-memory-agent tools in this exact order:',
    '1. memory_refresh_docs',
    '2. memory_query with the question "What exact sentence in README.md identifies this repository as the manual integration test fixture? Quote the sentence exactly."',
    '3. memory_status',
    'Do not skip any tool call.',
    'After the tool calls, respond with exactly these lines and nothing else:',
    'ANSWER: <the quoted README sentence>',
    'DB: <the shared database path from memory_status>',
    'STATUS: ok'
  ].join('\n');

  const executionEnv = {
    ...process.env,
    HOME: isolatedHome
  };

  if (dryRun) {
    const summary = {
      scratchRoot,
      projectRoot,
      isolatedHome,
      tarballPath,
      model,
      providerID,
      apiKeyEnvName: apiKeyEnvName ?? null,
      providerBaseURL: providerBaseURL || null
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const stdoutPath = join(logsDir, 'opencode.stdout.log');
  const stderrPath = join(logsDir, 'opencode.stderr.log');
  let integrationRun;
  try {
    integrationRun = await run('opencode', ['run', prompt], {
      cwd: projectRoot,
      env: executionEnv
    });
  } catch (error) {
    await writeFile(stdoutPath, error?.stdout ?? '');
    await writeFile(stderrPath, error?.stderr ?? '');
    throw new Error(
      `OpenCode integration run failed. Logs written to ${stdoutPath} and ${stderrPath}.\n${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  await writeFile(stdoutPath, integrationRun.stdout);
  await writeFile(stderrPath, integrationRun.stderr);

  const output = integrationRun.stdout.trim();
  const normalizedOutput = output.replace(/\\/g, '/');
  const statusPath = join(projectRoot, '.opencode', 'memory', 'private', 'status.json');
  const docsPath = join(projectRoot, '.opencode', 'memory', 'shared', 'project-docs.json');

  const answerLine = output
    .split('\n')
    .find((line) => line.startsWith('ANSWER:'))
    ?.replace(/^ANSWER:\s*/, '')
    .trim()
    .replace(/^["'`]|["'`]$/g, '');
  if (answerLine !== EXPECTED_FIXTURE_SENTENCE) {
    throw new Error(`The OpenCode response did not include the expected quoted answer.\nLogs: ${stdoutPath}\n${output}`);
  }
  if (!normalizedOutput.includes('/.opencode/memory/shared/memory.db')) {
    throw new Error(`The OpenCode response did not include the shared database path.\nLogs: ${stdoutPath}\n${output}`);
  }
  if (!existsSync(statusPath) || !existsSync(docsPath)) {
    throw new Error(`Expected plugin artifacts were not created.\nstatus.json: ${statusPath}\nproject-docs.json: ${docsPath}`);
  }

  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  const docs = JSON.parse(await readFile(docsPath, 'utf8'));
  console.log(
    JSON.stringify(
      {
        ok: true,
        scratchRoot,
        logsDir,
        model,
        providerID,
        docsCount: Array.isArray(docs.docs) ? docs.docs.length : null,
        currentActivity: status.currentActivity,
        dbFile: status.storage?.dbFile ?? null
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
