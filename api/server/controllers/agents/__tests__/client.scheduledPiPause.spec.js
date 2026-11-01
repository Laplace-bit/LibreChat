const { EModelEndpoint, Tools } = require('librechat-data-provider');
const { GenerationJobManager, createStreamServices } = require('@librechat/api');
const AgentClient = require('../client');

describe('Pi scheduled approval lifecycle', () => {
  beforeEach(async () => {
    await GenerationJobManager.destroy();
    GenerationJobManager.configure({ ...createStreamServices(), cleanupOnComplete: false });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('fails closed when scheduled approval state is not shared across replicas', async () => {
    const client = Object.create(AgentClient.prototype);
    client.options = {
      req: { _isScheduledFire: true },
      agent: { id: 'agent-pi' },
    };
    client.responseMessageId = 'response-pi-scheduled';

    await expect(
      client.handlePiPauseInterrupt(
        { kind: 'tool_approval', toolCall: {} },
        'scheduled-pi-approval',
      ),
    ).rejects.toMatchObject({ code: 'SCHEDULED_HITL_REQUIRES_SHARED_STORE' });
  });

  it('persists scheduled Pi approvals through the shared durable job manager', async () => {
    jest.spyOn(GenerationJobManager, 'isRedis', 'get').mockReturnValue(true);
    const streamId = 'scheduled-pi-approval';
    const scheduleId = 'schedule-pi-approval';
    const scheduledFor = '2026-11-01T12:00:00.000Z';
    const job = await GenerationJobManager.createJob(streamId, 'user-pi', streamId, {
      initialMetadata: {
        scheduleId,
        scheduledFor,
        scheduleConfigRevision: 3,
        agentRuntime: { engine: 'pi', sdkVersion: '1.4.0' },
      },
    });
    const client = Object.create(AgentClient.prototype);
    client.options = {
      req: {
        _isScheduledFire: true,
        user: { id: 'user-pi', tenantId: 'tenant-pi' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-pi', scheduleId },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
      agent: {
        id: 'agent-pi',
        tools: [{ name: Tools.file_search }],
        toolDefinitions: [],
      },
      eventHandlers: {},
    };
    client.agentConfigs = new Map();
    client.conversationId = streamId;
    client.responseMessageId = 'response-pi-scheduled';
    client.jobCreatedAt = job.createdAt;
    client.contentParts = [];
    client.getEncoding = () => 'o200k_base';

    await client.handlePiPauseInterrupt(
      {
        kind: 'tool_approval',
        toolCall: {
          toolCallId: 'pi-call-1',
          name: Tools.file_search,
          args: { query: 'maintenance manual' },
          review: { allowedDecisions: ['approve', 'reject'] },
          hostExecution: {
            toolCallId: 'host-call-1',
            toolTurn: 0,
            stepIdentity: {
              id: 'pi-step-1',
              index: 0,
              messageId: client.responseMessageId,
              runId: client.responseMessageId,
              agentId: 'agent-pi',
            },
            createdAt: 100,
          },
        },
      },
      streamId,
    );

    const paused = await GenerationJobManager.getJob(streamId);
    expect(paused).toMatchObject({
      createdAt: job.createdAt,
      status: 'requires_action',
      metadata: {
        scheduleId,
        scheduledFor,
        scheduleConfigRevision: 3,
        agentRuntime: { engine: 'pi', sdkVersion: '1.4.0' },
        piResumeContinuation: {
          version: 1,
          actionId: paused.metadata.pendingAction.actionId,
          toolName: Tools.file_search,
          args: { query: 'maintenance manual' },
        },
        pendingAction: {
          payload: {
            type: 'tool_approval',
          },
        },
      },
    });
    expect(client.pendingApproval.actionId).toBe(paused.metadata.pendingAction.actionId);
  });
});
