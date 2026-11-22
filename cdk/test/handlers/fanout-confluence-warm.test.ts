/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/** Fan-out hook for Confluence token warming (Task 14 (fork), #57). */

import type { DynamoDBRecord } from 'aws-lambda';

const mockDdbSend = jest.fn().mockResolvedValue({ Item: undefined });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

const mockWarm = jest.fn();
jest.mock('../../src/handlers/shared/confluence-publishing', () => ({
  warmConfluenceToken: (...args: unknown[]) => mockWarm(...args),
}));

const mockDispatchSlack = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/handlers/slack-notify', () => ({
  dispatchSlackEvent: (...args: unknown[]) => mockDispatchSlack(...args),
  SlackApiError: class SlackApiError extends Error {},
}));

import { handler, maybeWarmConfluenceToken } from '../../src/handlers/fanout-task-events';

function taskCreated(metadata: Record<string, unknown>) {
  return {
    task_id: 't-1',
    event_id: '01ABC',
    event_type: 'task_created',
    timestamp: '2026-11-22T00:00:00Z',
    metadata,
  };
}

beforeEach(() => {
  mockWarm.mockReset().mockResolvedValue('warmed');
});

describe('maybeWarmConfluenceToken', () => {
  test('warms on task_created with the repo and workflow from the event metadata', async () => {
    await maybeWarmConfluenceToken(taskCreated({
      repo: 'acme/docs',
      resolved_workflow: 'knowledge/web-research-v1',
      channel_source: 'slack',
    }));
    expect(mockWarm).toHaveBeenCalledWith({
      task_id: 't-1',
      repo: 'acme/docs',
      workflowId: 'knowledge/web-research-v1',
    });
  });

  test('ignores every other event type', async () => {
    await maybeWarmConfluenceToken({
      ...taskCreated({ repo: 'acme/docs', resolved_workflow: 'knowledge/web-research-v1' }),
      event_type: 'session_started',
    });
    expect(mockWarm).not.toHaveBeenCalled();
  });

  test.each([
    ['no repo (repo-less task)', { repo: null, resolved_workflow: 'knowledge/web-research-v1' }],
    ['no workflow (event written before this change)', { repo: 'acme/docs' }],
  ])('skips with %s', async (_case, metadata) => {
    await maybeWarmConfluenceToken(taskCreated(metadata));
    expect(mockWarm).not.toHaveBeenCalled();
  });
});

describe('handler', () => {
  test('warms on a task_created stream record without failing the batch', async () => {
    const record: DynamoDBRecord = {
      eventID: 'e-1',
      eventName: 'INSERT',
      dynamodb: {
        NewImage: {
          task_id: { S: 't-1' },
          event_id: { S: '01ABC' },
          event_type: { S: 'task_created' },
          timestamp: { S: '2026-11-22T00:00:00Z' },
          metadata: {
            M: {
              repo: { S: 'acme/docs' },
              resolved_workflow: { S: 'knowledge/web-research-v1' },
              channel_source: { S: 'api' },
            },
          },
        },
      },
    };
    const result = await handler({ Records: [record] });
    expect(mockWarm).toHaveBeenCalledTimes(1);
    expect(result.batchItemFailures).toEqual([]);
  });
});
