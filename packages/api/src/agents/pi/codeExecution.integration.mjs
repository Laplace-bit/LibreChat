import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, verify as verifySignature } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Constants as AgentConstants, createBashExecutionTool } from '@librechat/agents';

const require = createRequire(import.meta.url);
const {
  createPiCodeSessionBridge,
  createPiHostEventSequencer,
  createPiHostToolBatchExecutor,
  createPiHostToolExecutor,
  createPiTools,
  createToolExecuteHandler,
  getCodeApiAuthHeaders,
} = require('../../../dist/index.cjs');

const ENVIRONMENT_KEYS = [
  'CODEAPI_AUTH_PROVIDER',
  'CODEAPI_JWT_ENABLED',
  'CODEAPI_JWT_PRIVATE_KEY',
  'CODEAPI_JWT_PRIVATE_KEY_BASE64',
  'CODEAPI_JWT_PRIVATE_JWK_JSON',
  'CODEAPI_JWT_ALGORITHM',
  'CODEAPI_JWT_KID',
  'CODEAPI_JWT_KEY_ID',
  'CODEAPI_JWT_ISSUER',
  'CODEAPI_JWT_AUDIENCE',
  'CODEAPI_JWT_TTL_SECONDS',
  'CODEAPI_JWT_MINT_CACHE_SECONDS',
  'CODEAPI_JWT_SINGLE_TENANT_ID',
  'TENANT_ISOLATION_STRICT',
];

function decodeAndVerifyBearer(request, publicKey) {
  const authorization = request.headers.authorization;
  assert.equal(typeof authorization, 'string');
  const [scheme, token] = authorization.split(' ');
  assert.equal(scheme, 'Bearer');
  assert.equal(typeof token, 'string');
  const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');
  assert.ok(encodedHeader && encodedClaims && encodedSignature);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = Buffer.from(encodedSignature, 'base64url');
  assert.equal(verifySignature(null, Buffer.from(signingInput), publicKey, signature), true);
  return {
    token,
    header: JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')),
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('error', reject);
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('Pi bash tool sends a Code API request with signed tenant-bound JWT claims', async () => {
  const originalEnvironment = Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  const keyPair = generateKeyPairSync('ed25519');
  const jwtKeyId = `pi-code-api-integration-${randomUUID()}`;
  process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
  process.env.CODEAPI_JWT_ENABLED = 'false';
  process.env.CODEAPI_JWT_PRIVATE_KEY = keyPair.privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  });
  process.env.CODEAPI_JWT_ALGORITHM = 'EdDSA';
  process.env.CODEAPI_JWT_KID = jwtKeyId;
  process.env.CODEAPI_JWT_ISSUER = 'librechat';
  process.env.CODEAPI_JWT_AUDIENCE = 'codeapi';

  const observed = [];
  let fixtureError;
  const server = createServer(async (request, response) => {
    try {
      const body = await readRequestBody(request);
      const bearer = decodeAndVerifyBearer(request, keyPair.publicKey);
      observed.push({
        method: request.method,
        url: request.url,
        body,
        header: bearer.header,
        claims: bearer.claims,
        token: bearer.token,
        remoteAddress: request.socket.remoteAddress,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'completed',
          stdout: 'pi-code-api-result',
          stderr: '',
          session_id: 'code-api-session-1',
        }),
      );
    } catch (error) {
      fixtureError = error;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid fixture request' }));
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const request = {
      user: {
        id: 'pi-user-1',
        _id: { toString: () => 'pi-user-1' },
        tenantId: 'tenant-pi-code-1',
        role: 'USER',
        provider: 'local',
      },
      body: { tenant_id: 'attacker-selected-tenant' },
      headers: { 'x-tenant-id': 'attacker-header-tenant' },
    };
    const codeApiUrl = `http://127.0.0.1:${port}/v1`;
    const bashTool = createBashExecutionTool({
      baseUrl: codeApiUrl,
      executionProfile: 'default',
      authHeaders: () => getCodeApiAuthHeaders(request),
    });
    const handler = createToolExecuteHandler({
      loadTools: async (toolNames, agentId) => {
        assert.deepEqual(toolNames, [AgentConstants.BASH_TOOL]);
        assert.equal(agentId, 'agent-pi-code-api-1');
        return { loadedTools: [bashTool] };
      },
    });
    const codeSessionBridge = createPiCodeSessionBridge({
      session_id: 'pi-owned-session-1',
      files: [
        {
          id: 'code-file-1',
          resource_id: 'resource-1',
          name: 'authorized-input.txt',
          storage_session_id: 'storage-session-1',
          kind: 'user',
        },
      ],
    });
    const hostBatchExecutor = createPiHostToolBatchExecutor({
      handler,
      userId: request.user.id,
      agentId: 'agent-pi-code-api-1',
      request,
      threadId: 'thread-pi-code-api-1',
      runId: 'run-pi-code-api-1',
      metadata: {},
      authorizedToolNames: [AgentConstants.BASH_TOOL],
      codeSessionBridge,
    });
    const hostEvents = [];
    const eventSequencer = createPiHostEventSequencer((event) => hostEvents.push(event));
    const executeHostTool = createPiHostToolExecutor({
      createStepIdentity: () => ({
        id: 'pi-code-api-step-1',
        index: 0,
        messageId: 'pi-code-api-message-1',
        runId: 'run-pi-code-api-1',
        agentId: 'agent-pi-code-api-1',
      }),
      createToolCallId: () => 'host-code-api-call-1',
      executeHostToolCall: hostBatchExecutor,
      getCodeSessionContext: () => codeSessionBridge.snapshot(),
      handleHostEvent: eventSequencer.enqueue,
    });
    const [piBashTool] = createPiTools({
      definitions: [
        {
          name: AgentConstants.BASH_TOOL,
          description: 'Execute code through the authorized Code API.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } },
              intent: { type: 'string' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
      ],
      execute: executeHostTool,
    });

    await assert.rejects(
      piBashTool.execute('pi-code-api-invalid-call', {
        command: 'printf should-not-run',
        runtime_session_hint: 'attacker-session',
      }),
      { code: 'PI_TOOL_ARGUMENTS_INVALID' },
    );
    assert.equal(observed.length, 0, 'invalid or untrusted arguments never reach the Code API');

    const result = await piBashTool.execute('pi-code-api-call-1', {
      command: 'printf pi-code-api-result',
    });
    await eventSequencer.drain();

    assert.equal(fixtureError, undefined);
    assert.deepEqual(
      observed.map(({ method, url }) => ({ method, url })),
      [{ method: 'POST', url: '/v1/exec' }],
    );
    assert.equal(observed[0].remoteAddress.startsWith('127.'), true);
    assert.deepEqual(observed[0].body, {
      lang: 'bash',
      code: 'printf pi-code-api-result',
      files: [
        {
          id: 'code-file-1',
          resource_id: 'resource-1',
          name: 'authorized-input.txt',
          storage_session_id: 'storage-session-1',
          kind: 'user',
        },
      ],
    });
    assert.equal(
      Object.hasOwn(observed[0].body, 'session_id'),
      false,
      'the managed stateless endpoint does not receive client or Pi session identity',
    );
    assert.equal(observed[0].header.alg, 'EdDSA');
    assert.equal(observed[0].header.kid, jwtKeyId);
    assert.deepEqual(
      {
        iss: observed[0].claims.iss,
        aud: observed[0].claims.aud,
        sub: observed[0].claims.sub,
        tenant_id: observed[0].claims.tenant_id,
        role: observed[0].claims.role,
        principal_source: observed[0].claims.principal_source,
      },
      {
        iss: 'librechat',
        aud: 'codeapi',
        sub: 'pi-user-1',
        tenant_id: 'tenant-pi-code-1',
        role: 'USER',
        principal_source: 'librechat_jwt',
      },
    );
    assert.notEqual(observed[0].claims.tenant_id, request.body.tenant_id);
    assert.notEqual(observed[0].claims.tenant_id, request.headers['x-tenant-id']);
    assert.match(JSON.stringify(result), /pi-code-api-result/);
    assert.equal(JSON.stringify(result).includes(observed[0].token), false);
    assert.equal(JSON.stringify(hostEvents).includes(observed[0].token), false);
    assert.equal(observed.length, 1, 'one Pi tool call causes one Code API request');
  } finally {
    try {
      if (server.listening) {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      for (const key of ENVIRONMENT_KEYS) {
        if (originalEnvironment[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnvironment[key];
        }
      }
    }
  }
});
