#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TrustVoiceStack } from '../lib/trust-voice-stack';

const app = new cdk.App();

new TrustVoiceStack(app, 'TrustVoiceStack', {
  // Pinned to your account and region so CDK never accidentally deploys
  // to the wrong place. Account ID comes from your active CLI credentials.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'The Trust Voice — video ingestion and AI query platform',
});
