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

import { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/** Properties for {@link PlanningSessionTable}. */
export interface PlanningSessionTableProps {
  /**
   * Removal policy for the table.
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Whether to enable point-in-time recovery.
   * @default true
   */
  readonly pointInTimeRecovery?: boolean;
}

/**
 * One row per planning draft delivered to Slack with Approve and Cancel
 * buttons (Task 15 (fork), #82 PR 3b-1).
 *
 * Schema: `session_id` (PK), a random opaque id that the buttons carry.
 *
 * Fields (see `cdk/src/handlers/shared/planning-session.ts`):
 * - requester: `slack_team_id`, `slack_user_id`, `platform_user_id`
 * - `task_id`, `repo`, `page_id`
 * - `slack_channel_id`, `slack_thread_ts`, `slack_message_ts`
 * - `state` — `drafted` | `approving` | `filed` | `cancelled`, with the
 *   `approving_since` lease and the pending `confirm_digest`
 * - `created_at`, `expires_at` (TTL, 7 days)
 *
 * No Slack message text and no page content is stored: only references, the
 * state and a digest of the checked plan.
 */
export class PlanningSessionTable extends Construct {
  /** The underlying DynamoDB table. */
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: PlanningSessionTableProps = {}) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      partitionKey: {
        name: 'session_id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expires_at',
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: props.pointInTimeRecovery ?? true,
      },
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
    });
  }
}
