/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  this software and associated documentation files (the "Software"), to deal in
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

import crypto from 'node:crypto';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const APP_ACTOR_MIN_SECRET_LENGTH = 32;
const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const COMMENT_ID_RE = /^\d+$/;
const TRANSITION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// Mirrors cli/src/commands/jira.ts's PROJECT_KEY_RE.
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,99}$/;
const MAX_SUMMARY_LENGTH = 255; // Jira's own summary field limit.
// #82 PR 3b-2: the only label a created issue may carry is the planning
// session's own `factory-plan-<8 base32 chars>` marker, never a trigger label.
const PLAN_LABEL_RE = /^factory-plan-[a-z2-7]{8}$/;
const MAX_CREATE_LABELS = 1;
// A company-managed project's Epic Name field, set only to the summary.
const EPIC_NAME_FIELD_RE = /^customfield_\d{1,10}$/;
// The only link type `link_issues` creates.
const BLOCKS_LINK_TYPE = 'Blocks';

function response(statusCode, body = '') {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function headerValue(headers, wanted) {
  const entry = Object.entries(headers ?? {})
    .find(([name]) => name.toLowerCase() === wanted.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] : value;
}

export function computeSignature(secret, timestamp, body) {
  return `sha256=${crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
}

function authenticRequest(event, secret, nowSeconds) {
  if (!secret || secret.length < APP_ACTOR_MIN_SECRET_LENGTH) return false;
  const timestamp = headerValue(event.headers, 'x-bgagent-timestamp');
  const supplied = headerValue(event.headers, 'x-bgagent-signature');
  if (!timestamp || !supplied || !/^\d+$/.test(timestamp)) return false;

  const sentAt = Number(timestamp);
  if (!Number.isSafeInteger(sentAt) || Math.abs(nowSeconds - sentAt) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }

  const expected = computeSignature(secret, timestamp, event.body ?? '');
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

function parsePayload(event) {
  if (event.method !== 'POST') return { error: response(405, { error: 'method_not_allowed' }) };
  const body = event.body ?? '';
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || value.version !== 1) {
      return { error: response(400, { error: 'invalid_payload' }) };
    }
    if (typeof value.cloud_id !== 'string' || value.cloud_id.length === 0) {
      return { error: response(400, { error: 'cloud_id_required' }) };
    }
    return { value };
  } catch {
    return { error: response(400, { error: 'invalid_json' }) };
  }
}

async function jiraResponse(result) {
  const body = await result.text();
  return response(result.status, body);
}

async function identityResponse(identityResult, serverInfoResult) {
  if (!identityResult.ok) return jiraResponse(identityResult);
  if (!serverInfoResult.ok) return jiraResponse(serverInfoResult);
  const identity = await identityResult.json();
  const serverInfo = await serverInfoResult.json();
  return response(200, {
    account_id: identity.accountId,
    account_type: identity.accountType,
    display_name: identity.displayName,
    site_url: serverInfo.baseUrl,
  });
}

export function createProxyHandler({
  requestJira,
  route,
  secretProvider = () => process.env.BGAGENT_PROXY_SECRET ?? '',
  nowProvider = () => Math.floor(Date.now() / 1000),
}) {
  return async function proxyHandler(event) {
    const secret = secretProvider();
    if (!secret || secret.length < APP_ACTOR_MIN_SECRET_LENGTH) {
      console.error(
        `BGAGENT_PROXY_SECRET is missing or shorter than ${APP_ACTOR_MIN_SECRET_LENGTH} characters`,
      );
      return response(503, { error: 'proxy_not_configured' });
    }
    const rawBody = event.body ?? '';
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      return response(413, { error: 'payload_too_large' });
    }
    if (!authenticRequest(event, secret, nowProvider())) {
      return response(401, { error: 'invalid_signature' });
    }

    const parsed = parsePayload(event);
    if (parsed.error) return parsed.error;
    const payload = parsed.value;

    try {
      switch (payload.operation) {
        case 'identity': {
          const [identityResult, serverInfoResult] = await Promise.all([
            requestJira(
              route`/rest/api/3/myself`,
              { headers: { Accept: 'application/json' } },
            ),
            requestJira(
              route`/rest/api/3/serverInfo`,
              { headers: { Accept: 'application/json' } },
            ),
          ]);
          return identityResponse(identityResult, serverInfoResult);
        }
        case 'comment':
          if (
            !ISSUE_KEY_RE.test(payload.issue_key ?? '')
            || !payload.body
            || typeof payload.body !== 'object'
            || Array.isArray(payload.body)
          ) {
            return response(400, { error: 'invalid_comment_request' });
          }
          return jiraResponse(await requestJira(
            route`/rest/api/3/issue/${payload.issue_key}/comment`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body: payload.body }),
            },
          ));
        case 'update_comment':
          if (
            !ISSUE_KEY_RE.test(payload.issue_key ?? '')
            || !COMMENT_ID_RE.test(payload.comment_id ?? '')
            || !payload.body
            || typeof payload.body !== 'object'
            || Array.isArray(payload.body)
          ) {
            return response(400, { error: 'invalid_update_comment_request' });
          }
          return jiraResponse(await requestJira(
            route`/rest/api/3/issue/${payload.issue_key}/comment/${payload.comment_id}`,
            {
              method: 'PUT',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body: payload.body }),
            },
          ));
        case 'get_transitions':
          if (!ISSUE_KEY_RE.test(payload.issue_key ?? '')) {
            return response(400, { error: 'invalid_issue_key' });
          }
          return jiraResponse(await requestJira(
            route`/rest/api/3/issue/${payload.issue_key}?fields=status&expand=transitions`,
            { headers: { Accept: 'application/json' } },
          ));
        case 'transition':
          if (
            !ISSUE_KEY_RE.test(payload.issue_key ?? '')
            || !TRANSITION_ID_RE.test(payload.transition_id ?? '')
          ) {
            return response(400, { error: 'invalid_transition_request' });
          }
          return jiraResponse(await requestJira(
            route`/rest/api/3/issue/${payload.issue_key}/transitions`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ transition: { id: payload.transition_id } }),
            },
          ));
        case 'create_issue':
          // No separate createmeta round trip: Jira's own create response already
          // reports exactly which required field (or an invalid issuetype name) is
          // missing via a 400 with an `errors` map, which the caller (create-task-
          // core.ts) uses to decide whether to skip. This proxy only validates the
          // shape of what WE are sending, not whether the project accepts it.
          if (
            !PROJECT_KEY_RE.test(payload.project_key ?? '')
            || typeof payload.issue_type_name !== 'string'
            || payload.issue_type_name.trim().length === 0
            || typeof payload.summary !== 'string'
            || payload.summary.trim().length === 0
            || payload.summary.length > MAX_SUMMARY_LENGTH
            || (payload.body !== undefined
              && (typeof payload.body !== 'object' || Array.isArray(payload.body)))
          ) {
            return response(400, { error: 'invalid_create_issue_request' });
          }
          if (payload.parent_key !== undefined && !ISSUE_KEY_RE.test(payload.parent_key ?? '')) {
            return response(400, { error: 'invalid_parent_key' });
          }
          if (
            payload.labels !== undefined
            && (
              !Array.isArray(payload.labels)
              || payload.labels.length > MAX_CREATE_LABELS
              || !payload.labels.every((label) => typeof label === 'string' && PLAN_LABEL_RE.test(label))
            )
          ) {
            return response(400, { error: 'invalid_plan_label' });
          }
          if (payload.epic_name_field !== undefined && !EPIC_NAME_FIELD_RE.test(payload.epic_name_field ?? '')) {
            return response(400, { error: 'invalid_epic_name_field' });
          }
          return jiraResponse(await requestJira(
            route`/rest/api/3/issue`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                fields: {
                  project: { key: payload.project_key },
                  issuetype: { name: payload.issue_type_name },
                  summary: payload.summary,
                  ...(payload.body !== undefined && { description: payload.body }),
                  ...(payload.parent_key !== undefined && { parent: { key: payload.parent_key } }),
                  ...(payload.labels !== undefined && payload.labels.length > 0 && { labels: payload.labels }),
                  ...(payload.epic_name_field !== undefined && { [payload.epic_name_field]: payload.summary }),
                },
              }),
            },
          ));
        case 'link_issues':
          // "outward_issue_key blocks inward_issue_key". Only the Blocks type,
          // between two different issues.
          if (
            payload.link_type !== BLOCKS_LINK_TYPE
            || !ISSUE_KEY_RE.test(payload.outward_issue_key ?? '')
            || !ISSUE_KEY_RE.test(payload.inward_issue_key ?? '')
            || payload.outward_issue_key === payload.inward_issue_key
          ) {
            return response(400, { error: 'invalid_link_issues_request' });
          }
          return jiraResponse(await requestJira(
            route`/rest/api/3/issueLink`,
            {
              method: 'POST',
              headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                type: { name: BLOCKS_LINK_TYPE },
                outwardIssue: { key: payload.outward_issue_key },
                inwardIssue: { key: payload.inward_issue_key },
              }),
            },
          ));
        default:
          return response(400, { error: 'unsupported_operation' });
      }
    } catch (error) {
      console.error('Jira app-actor proxy request failed', {
        operation: payload.operation,
        error: error instanceof Error ? error.message : String(error),
      });
      return response(502, { error: 'jira_request_failed' });
    }
  };
}
