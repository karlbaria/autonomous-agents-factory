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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { createTaskCore } from './shared/create-task-core';
import { buildChannelMetadata, extractUserGroups, extractUserId } from './shared/gateway';
import { logger } from './shared/logger';
import { lookupRepo } from './shared/repo-config';
import { ErrorCode, errorResponse } from './shared/response';
import type { CreateTaskRequest } from './shared/types';
import { parseBody } from './shared/validation';
import { resolveChannelDefaultWorkflow } from './shared/workflows';

/**
 * POST /v1/tasks — Create a new task (Cognito-authenticated).
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Extract authenticated user
    const userId = extractUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCode.UNAUTHORIZED, 'Missing or invalid authentication.', requestId);
    }

    // 2. Parse request body
    const body = parseBody<CreateTaskRequest>(event.body);
    if (!body) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }

    // 3. Extract idempotency key
    const idempotencyKey = event.headers['Idempotency-Key'] ?? event.headers['idempotency-key'];

    // 3a. Explicit coding workflow when the caller named neither a workflow
    // nor a repo-less request: a repo-bound API task must not fall through
    // the resolution ladder to the repo-less default/agent-v1 (which never
    // commits or opens a PR), mirroring the Jira/Slack/webhook/orchestration-
    // release call sites. Task 13 (fork)/#39: the repo's own default_workflow
    // wins when set. A caller that explicitly wants the repo-less fallback
    // can still send workflow_ref itself (or omit repo entirely).
    let resolvedBody = body;
    if (body.workflow_ref === undefined && body.repo) {
      const { config: apiTaskRepoConfig } = await lookupRepo(body.repo);
      resolvedBody = { ...body, workflow_ref: resolveChannelDefaultWorkflow(apiTaskRepoConfig) };
    }

    // 4. Delegate to shared core
    return await createTaskCore(resolvedBody, {
      userId,
      teamIds: extractUserGroups(event),
      channelSource: 'api',
      channelMetadata: buildChannelMetadata(event),
      idempotencyKey: idempotencyKey ?? undefined,
    }, requestId);
  } catch (err) {
    logger.error('Failed to create task', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
