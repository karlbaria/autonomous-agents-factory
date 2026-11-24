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

import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { SlackIntegration } from '../../src/constructs/slack-integration';

describe('SlackIntegration construct', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const api = new apigw.RestApi(stack, 'TestApi');
    const userPool = new cognito.UserPool(stack, 'TestUserPool');
    const taskTable = new dynamodb.Table(stack, 'TaskTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
    });
    const taskEventsTable = new dynamodb.Table(stack, 'TaskEventsTable', {
      partitionKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    new SlackIntegration(stack, 'SlackIntegration', {
      api,
      userPool,
      taskTable,
      taskEventsTable,
    });

    template = Template.fromStack(stack);
  });

  test('creates four Slack DynamoDB tables (installation + user mapping + channel mapping + planning sessions)', () => {
    // TaskTable + TaskEventsTable + SlackInstallation + SlackUserMapping + SlackChannelMapping
    // + PlanningSession (#82 PR 3b-1) = 6
    template.resourceCountIs('AWS::DynamoDB::Table', 6);
  });

  // Task 15 (fork), #82 PR 3b-1.
  describe('planning sessions', () => {
    function logicalId(type: string, fragment: string): string {
      const ids = Object.keys(template.findResources(type)).filter((id) => id.includes(fragment));
      expect(ids).toHaveLength(1);
      return ids[0];
    }

    function statementsOf(fnFragment: string): Array<Record<string, any>> {
      const fnId = logicalId('AWS::Lambda::Function', fnFragment);
      const fn = template.findResources('AWS::Lambda::Function')[fnId];
      const roleId = fn.Properties.Role['Fn::GetAtt'][0];
      return Object.values(template.findResources('AWS::IAM::Policy'))
        .filter((p) => p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleId))
        .flatMap((p) => p.Properties.PolicyDocument.Statement);
    }

    function refersTo(resource: unknown, id: string): boolean {
      return JSON.stringify(resource).includes(`"${id}"`);
    }

    test('the table is keyed by session_id with a 7-day TTL attribute', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: [{ AttributeName: 'session_id', KeyType: 'HASH' }],
        TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    test('the command processor can only Get and Update session rows', () => {
      const tableId = logicalId('AWS::DynamoDB::Table', 'PlanningSession');
      const onTable = statementsOf('CommandProcessorFn').filter((st) => refersTo(st.Resource, tableId));
      expect(onTable).toEqual([
        expect.objectContaining({ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:UpdateItem'] }),
      ]);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: Match.objectLike({ PLANNING_SESSION_TABLE_NAME: { Ref: tableId } }) },
      });
    });

    test('the interactions Lambda may invoke the command processor and has no session-table access', () => {
      const tableId = logicalId('AWS::DynamoDB::Table', 'PlanningSession');
      const processorId = logicalId('AWS::Lambda::Function', 'CommandProcessorFn');
      const statements = statementsOf('SlackInteractionsFn');
      expect(statements.some((st) => refersTo(st.Resource, tableId))).toBe(false);
      const invoke = statements.filter((st) => JSON.stringify(st.Action).includes('lambda:InvokeFunction'));
      expect(invoke).toHaveLength(1);
      expect(refersTo(invoke[0].Resource, processorId)).toBe(true);
    });

    test('no other Slack Lambda can touch the session table', () => {
      const tableId = logicalId('AWS::DynamoDB::Table', 'PlanningSession');
      for (const fragment of ['SlackEventsFn', 'SlackCommandsFn', 'SlackLinkFn', 'OAuthCallbackFn']) {
        expect(statementsOf(fragment).some((st) => refersTo(st.Resource, tableId))).toBe(false);
      }
    });
  });

  test('command processor receives the channel-mapping table env var', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          SLACK_CHANNEL_MAPPING_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('creates 6 Lambda functions', () => {
    // oauth-callback, events, commands, command-processor, link, interactions
    // (outbound notify runs on FanOutConsumer as a dispatcher, not its own fn)
    template.resourceCountIs('AWS::Lambda::Function', 6);
  });

  test('creates API Gateway resources under /slack', () => {
    // Verify /slack/* routes exist
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'slack',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'commands',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'events',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'link',
    });
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'interactions',
    });
  });

  test('slash command handler has 3-second timeout', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 3,
      Environment: {
        Variables: Match.objectLike({
          SLACK_SIGNING_SECRET_ARN: Match.anyValue(),
          SLACK_COMMAND_PROCESSOR_FUNCTION_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('construct no longer owns a TaskEventsTable stream consumer', () => {
    // This construct used to own ``SlackNotifyFn`` plus its
    // own ``DynamoEventSource`` on ``TaskEventsTable``. Outbound Slack
    // delivery now runs through ``FanOutConsumer`` as a per-channel
    // dispatcher so ``TaskEventsTable`` stays within the DynamoDB
    // one-reader-per-shard practical limit. The assertion pins that the
    // migration did not regress: this construct must not create any
    // ``AWS::Lambda::EventSourceMapping`` at all.
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });

  test('creates 3 Secrets Manager secrets for Slack App credentials', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 3);
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('signing secret'),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('client secret'),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Description: Match.stringLikeRegexp('client ID'),
    });
  });

  test('OAuth callback has Secrets Manager permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'secretsmanager:CreateSecret',
            Effect: 'Allow',
            Condition: {
              StringLike: { 'secretsmanager:Name': 'bgagent/slack/*' },
            },
          }),
        ]),
      },
    });
  });
});
