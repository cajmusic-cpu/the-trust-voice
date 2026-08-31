import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { TrustVoiceStack } from '../lib/trust-voice-stack';

function synth(): Template {
  const app = new cdk.App();
  const stack = new TrustVoiceStack(app, 'TestStack', {
    env: { account: '111111111111', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('video playback path', () => {
  const template = synth();

  test('ttv-video-url runs with 512 MB so cold starts stay sub-second', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'ttv-video-url',
      MemorySize: 512,
    });
  });

  test('a 5-minute EventBridge rule keeps ttv-video-url warm', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'ttv-video-url-warmer',
      ScheduleExpression: 'rate(5 minutes)',
      Targets: Match.arrayWith([
        Match.objectLike({ Input: '{"warmup":true}' }),
      ]),
    });
  });

  test('the telemetry beacon endpoint is unauthenticated and throttled', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
      ResourceId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([
        Match.objectLike({
          ResourcePath: '/~1telemetry~1video',
          HttpMethod: 'POST',
          ThrottlingRateLimit: 20,
          ThrottlingBurstLimit: 40,
        }),
      ]),
    });
  });

  test('ttv-video-telemetry function exists', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'ttv-video-telemetry',
    });
  });
});
