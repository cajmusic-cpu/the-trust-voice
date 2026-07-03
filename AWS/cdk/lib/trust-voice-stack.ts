import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as config from 'aws-cdk-lib/aws-config';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { CLIENTS } from './config/clients';

export class TrustVoiceStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly chunksTable: dynamodb.Table;
  public readonly videosTable: dynamodb.Table;
  public readonly ingestLambdaRole: iam.Role;
  public readonly processLambdaRole: iam.Role;
  public readonly queryLambdaRole: iam.Role;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DYNAMODB TABLES ───────────────────────────────────────────────────────

    this.videosTable = new dynamodb.Table(this, 'VideosTable', {
      tableName: 'ttv-videos',
      partitionKey: { name: 'client_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'video_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.chunksTable = new dynamodb.Table(this, 'ChunksTable', {
      tableName: 'ttv-chunks',
      partitionKey: { name: 'client_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const queryLogTable = new dynamodb.Table(this, 'QueryLogTable', {
      tableName: 'ttv-query-log',
      partitionKey: { name: 'client_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const uploadTokensTable = new dynamodb.Table(this, 'UploadTokensTable', {
      tableName: 'ttv-upload-tokens',
      partitionKey: { name: 'token', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expires_at',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'VideosTableName', { value: this.videosTable.tableName });
    new cdk.CfnOutput(this, 'ChunksTableName', { value: this.chunksTable.tableName });

    // ── COGNITO USER POOL ─────────────────────────────────────────────────────
    //
    // selfSignUpEnabled: false — trustees are created by admin only.
    // MFA REQUIRED — every trustee must enroll an authenticator app.
    // Cognito groups (one per client) are created by the add-client tool,
    // NOT by this CDK stack. This avoids deploy failures when groups already
    // exist in AWS but are not tracked in CloudFormation.

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'ttv-trustees',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'ttv-web-client',
      authFlows: {
        userSrp: true,
      },
      generateSecret: false,
      accessTokenValidity: cdk.Duration.minutes(30),
      idTokenValidity: cdk.Duration.minutes(30),
      refreshTokenValidity: cdk.Duration.days(1),
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });

    // ── IAM ROLES ─────────────────────────────────────────────────────────────
    //
    // S3 permissions use wildcard ARNs (ttv-*-videos, ttv-*-transcripts) rather
    // than referencing specific bucket objects. This decouples IAM from per-client
    // bucket creation — new clients can be added without a CDK redeploy and without
    // risk of "resource already exists" CloudFormation errors.

    const meLambdaRole = new iam.Role(this, 'MeLambdaRole', {
      roleName: 'ttv-me-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    this.ingestLambdaRole = new iam.Role(this, 'IngestLambdaRole', {
      roleName: 'ttv-ingest-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // IngestLambda reads video files (event gives bucket+key; passes URI to MediaConvert/Transcribe)
    this.ingestLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::ttv-*-videos/*`],
    }));

    // Transcribe validates the output bucket using the calling role's credentials.
    // Without s3:PutObject on transcripts buckets, StartTranscriptionJob fails.
    this.ingestLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::ttv-*-transcripts/*`],
    }));

    const mediaConvertRole = new iam.Role(this, 'MediaConvertRole', {
      roleName: 'ttv-mediaconvert-role',
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
    });

    // MediaConvert reads the original video and writes audio.mp3 + optimized.mp4 back.
    mediaConvertRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [
        `arn:aws:s3:::ttv-*-videos`,
        `arn:aws:s3:::ttv-*-videos/*`,
      ],
    }));

    this.ingestLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'transcribe:StartTranscriptionJob',
        'transcribe:GetTranscriptionJob',
        'mediaconvert:CreateJob',
        'mediaconvert:GetJob',
        'mediaconvert:DescribeEndpoints',
      ],
      resources: ['*'],
    }));
    this.ingestLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [mediaConvertRole.roleArn],
    }));
    this.videosTable.grantWriteData(this.ingestLambdaRole);

    this.processLambdaRole = new iam.Role(this, 'ProcessLambdaRole', {
      roleName: 'ttv-process-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // ProcessTranscriptLambda reads Transcribe output JSON from any ttv transcript bucket
    this.processLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::ttv-*-transcripts/*`],
    }));
    this.chunksTable.grantWriteData(this.processLambdaRole);
    this.videosTable.grantWriteData(this.processLambdaRole);
    this.processLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
    }));
    this.processLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/pinecone-api-key*`,
      ],
    }));

    const videoUrlLambdaRole = new iam.Role(this, 'VideoUrlLambdaRole', {
      roleName: 'ttv-video-url-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // VideoUrlLambda generates presigned GET URLs — needs GetObject on all video buckets
    videoUrlLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::ttv-*-videos/*`],
    }));
    this.videosTable.grantReadData(videoUrlLambdaRole);

    this.queryLambdaRole = new iam.Role(this, 'QueryLambdaRole', {
      roleName: 'ttv-query-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    this.chunksTable.grantReadData(this.queryLambdaRole);
    this.videosTable.grantReadData(this.queryLambdaRole);
    queryLogTable.grantWriteData(this.queryLambdaRole);
    this.queryLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
    }));
    this.queryLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/anthropic-api-key*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/pinecone-api-key*`,
      ],
    }));

    // ── CLOUDWATCH LOG GROUPS ─────────────────────────────────────────────────

    const videoUrlLogs = new logs.LogGroup(this, 'VideoUrlLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-video-url',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const meLogs = new logs.LogGroup(this, 'MeLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-me',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const ingestLogs = new logs.LogGroup(this, 'IngestLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-ingest',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const processLogs = new logs.LogGroup(this, 'ProcessLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-process-transcript',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const queryLogs = new logs.LogGroup(this, 'QueryLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-query',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── VIDEO URL LAMBDA ──────────────────────────────────────────────────────

    const videoUrlFunction = new lambda_nodejs.NodejsFunction(this, 'VideoUrlFunction', {
      functionName: 'ttv-video-url',
      entry: path.join(__dirname, '..', 'lambdas', 'video-url', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: videoUrlLambdaRole,
      logGroup: videoUrlLogs,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        VIDEOS_TABLE: this.videosTable.tableName,
      },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });

    // ── UPLOAD URL LAMBDA ─────────────────────────────────────────────────────

    const uploadUrlLambdaRole = new iam.Role(this, 'UploadUrlLambdaRole', {
      roleName: 'ttv-upload-url-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    uploadTokensTable.grantReadData(uploadUrlLambdaRole);

    const uploadUrlLogs = new logs.LogGroup(this, 'UploadUrlLambdaLogs', {
      logGroupName: '/aws/lambda/ttv-upload-url',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const uploadUrlFunction = new lambda_nodejs.NodejsFunction(this, 'UploadUrlFunction', {
      functionName: 'ttv-upload-url',
      entry: path.join(__dirname, '..', 'lambdas', 'upload-url', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: uploadUrlLambdaRole,
      logGroup: uploadUrlLogs,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: { UPLOAD_TOKENS_TABLE: uploadTokensTable.tableName },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });

    // ── ME LAMBDA ─────────────────────────────────────────────────────────────
    //
    // CLIENTS_JSON is built from clients.ts and baked in at CDK synth time.
    // When adding a new client: (1) add it to clients.ts, (2) redeploy CDK to
    // update CLIENTS_JSON, (3) run `npm run add-client` to create the AWS resources.

    const meFunction = new lambda_nodejs.NodejsFunction(this, 'MeFunction', {
      functionName: 'ttv-me',
      entry: path.join(__dirname, '..', 'lambdas', 'me', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: meLambdaRole,
      logGroup: meLogs,
      timeout: cdk.Duration.seconds(10),
      environment: {
        CLIENTS_JSON: JSON.stringify(CLIENTS.map(c => ({ id: c.id, name: c.name }))),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // ── QUERY LAMBDA ──────────────────────────────────────────────────────────

    const queryFunction = new lambda_nodejs.NodejsFunction(this, 'QueryFunction', {
      functionName: 'ttv-query',
      entry: path.join(__dirname, '..', 'lambdas', 'query', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: this.queryLambdaRole,
      logGroup: queryLogs,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ANTHROPIC_SECRET_ARN: `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/anthropic-api-key`,
        PINECONE_SECRET_ARN: `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/pinecone-api-key`,
        PINECONE_INDEX_NAME: 'ttv-embeddings',
        PINECONE_INDEX_HOST: 'https://ttv-embeddings-he5dsra.svc.aped-4627-b74a.pinecone.io',
        QUERY_LOG_TABLE: queryLogTable.tableName,
        CHUNKS_TABLE: this.chunksTable.tableName,
        VIDEOS_TABLE: this.videosTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    // ── INGEST LAMBDA ─────────────────────────────────────────────────────────
    //
    // S3 ObjectCreated events on client video buckets invoke this function.
    // Bucket notifications are configured by the add-client tool (not CDK) so
    // that new clients can be added without a CDK redeploy.
    //
    // addPermission with sourceAccount (no sourceArn) allows any S3 bucket
    // in this account to invoke the function. The naming convention (ttv-*-videos)
    // and the routing logic inside the Lambda act as the effective scope.

    const ingestFunction = new lambda_nodejs.NodejsFunction(this, 'IngestFunction', {
      functionName: 'ttv-ingest',
      entry: path.join(__dirname, '..', 'lambdas', 'ingest', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: this.ingestLambdaRole,
      logGroup: ingestLogs,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        VIDEOS_TABLE: this.videosTable.tableName,
        MEDIACONVERT_ROLE_ARN: mediaConvertRole.roleArn,
      },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });

    ingestFunction.addPermission('AllowS3VideoInvoke', {
      principal: new iam.ServicePrincipal('s3.amazonaws.com'),
      sourceAccount: this.account,
    });

    // ── PROCESS TRANSCRIPT LAMBDA ─────────────────────────────────────────────
    //
    // S3 ObjectCreated *.json events on client transcript buckets invoke this function.
    // Bucket notifications are also configured by the add-client tool.

    const processTranscriptFunction = new lambda_nodejs.NodejsFunction(
      this,
      'ProcessTranscriptFunction',
      {
        functionName: 'ttv-process-transcript',
        entry: path.join(__dirname, '..', 'lambdas', 'process-transcript', 'index.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        role: this.processLambdaRole,
        logGroup: processLogs,
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        environment: {
          VIDEOS_TABLE: this.videosTable.tableName,
          CHUNKS_TABLE: this.chunksTable.tableName,
          PINECONE_SECRET_ARN: `arn:aws:secretsmanager:${this.region}:${this.account}:secret:ttv/pinecone-api-key`,
          PINECONE_INDEX_NAME: 'ttv-embeddings',
          PINECONE_INDEX_HOST: 'https://ttv-embeddings-he5dsra.svc.aped-4627-b74a.pinecone.io',
        },
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'node22',
        },
      },
    );

    processTranscriptFunction.addPermission('AllowS3TranscriptInvoke', {
      principal: new iam.ServicePrincipal('s3.amazonaws.com'),
      sourceAccount: this.account,
    });

    // ── API GATEWAY ───────────────────────────────────────────────────────────

    const apiGwCloudWatchRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      roleName: 'ttv-apigateway-cloudwatch-role',
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ),
      ],
    });

    const apiGwAccount = new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGwCloudWatchRole.roleArn,
    });

    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/ttv/api-gateway/access',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigateway.RestApi(this, 'TrustVoiceApi', {
      restApiName: 'ttv-api',
      description: 'The Trust Voice trustee query API',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: false,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: false,
        }),
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: ['https://portal.thetrustvoice.com'],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Authorization', 'Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    this.api.node.addDependency(apiGwAccount);

    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'CognitoAuthorizer',
      {
        cognitoUserPools: [this.userPool],
        authorizerName: 'ttv-cognito-authorizer',
        identitySource: 'method.request.header.Authorization',
      },
    );

    const authOptions: apigateway.MethodOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const uploadUrlResource = this.api.root.addResource('upload-url', {
      defaultCorsPreflightOptions: {
        allowOrigins: ['https://upload.thetrustvoice.com'],
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
        maxAge: cdk.Duration.hours(1),
      },
    });
    uploadUrlResource.addMethod('GET', new apigateway.LambdaIntegration(uploadUrlFunction));

    const meResource = this.api.root.addResource('me');
    meResource.addMethod('GET', new apigateway.LambdaIntegration(meFunction), authOptions);

    const clientsResource = this.api.root.addResource('clients');
    const clientIdResource = clientsResource.addResource('{clientId}');
    const queryResource = clientIdResource.addResource('query');
    queryResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(queryFunction),
      authOptions,
    );

    const videosResource = clientIdResource.addResource('videos');
    const videoIdResource = videosResource.addResource('{videoId}');
    const videoUrlResource = videoIdResource.addResource('url');
    videoUrlResource.addMethod(
      'GET',
      new apigateway.LambdaIntegration(videoUrlFunction),
      authOptions,
    );

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway base URL',
    });

    // ── PORTAL FRONTEND (CloudFront + S3) ─────────────────────────────────────

    const portalBucket = new s3.Bucket(this, 'PortalBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const portalCert = acm.Certificate.fromCertificateArn(
      this,
      'PortalCertificate',
      'arn:aws:acm:us-east-1:595028889888:certificate/f97ae843-00e8-4295-91e7-072f106abedb',
    );

    const portalDistribution = new cloudfront.Distribution(this, 'PortalDistribution', {
      defaultBehavior: {
        origin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(portalBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
      domainNames: ['portal.thetrustvoice.com'],
      certificate: portalCert,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: false,
    });

    new cdk.CfnOutput(this, 'PortalDistributionDomain', {
      value: portalDistribution.distributionDomainName,
      description: 'Add as CNAME for portal.thetrustvoice.com in GoDaddy',
    });

    new cdk.CfnOutput(this, 'PortalDistributionId', {
      value: portalDistribution.distributionId,
      description: 'CloudFront distribution ID — needed for cache invalidation after deploys',
    });

    new cdk.CfnOutput(this, 'PortalBucketName', {
      value: portalBucket.bucketName,
      description: 'Deploy React build: aws s3 sync dist/ s3://<bucket> --delete',
    });

    // Grant the GitHub Actions deploy user access to sync the portal build to S3
    // and invalidate the CloudFront distribution after each deploy.
    const githubActionsUser = iam.User.fromUserName(this, 'GithubActionsUser', 'ttv-github-actions');
    portalBucket.grantReadWrite(githubActionsUser);
    portalBucket.grantDelete(githubActionsUser);
    portalDistribution.grantCreateInvalidation(githubActionsUser);

    // ── CLOUDWATCH 403 ALARM ──────────────────────────────────────────────────

    const forbidden403Filter = new logs.MetricFilter(this, 'Forbidden403Filter', {
      logGroup: apiAccessLogs,
      filterPattern: logs.FilterPattern.stringValue('$.status', '=', '403'),
      metricNamespace: 'TrustVoice/API',
      metricName: 'ForbiddenRequests',
      metricValue: '1',
      defaultValue: 0,
    });

    const securityAlertTopic = new sns.Topic(this, 'SecurityAlertTopic', {
      topicName: 'ttv-security-alerts',
      displayName: 'The Trust Voice — Security Alerts',
    });

    const alarm = new cloudwatch.Alarm(this, 'Forbidden403Alarm', {
      alarmName: 'ttv-403-spike',
      alarmDescription:
        '≥5 HTTP 403 responses in 5 minutes — possible cross-client access probe. ' +
        'Check /ttv/api-gateway/access logs immediately.',
      metric: forbidden403Filter.metric({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    alarm.addAlarmAction(new cloudwatch_actions.SnsAction(securityAlertTopic));

    new cdk.CfnOutput(this, 'SecurityAlertTopicArn', {
      value: securityAlertTopic.topicArn,
      description: 'Subscribe your email to this SNS topic to receive 403 spike alerts',
    });

    // ── AWS CONFIG — S3 SECURITY RULES ───────────────────────────────────────

    new config.ManagedRule(this, 'S3PublicReadProhibited', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_READ_PROHIBITED,
      description: 'S3 buckets must not allow public read access.',
    });

    new config.ManagedRule(this, 'S3PublicWriteProhibited', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_WRITE_PROHIBITED,
      description: 'S3 buckets must not allow public write access.',
    });

    new config.ManagedRule(this, 'S3SslRequestsOnly', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_SSL_REQUESTS_ONLY,
      description: 'S3 bucket policies must deny HTTP (non-TLS) requests.',
    });

    new config.ManagedRule(this, 'S3ServerSideEncryption', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED,
      description: 'S3 buckets must have default server-side encryption enabled.',
    });

    new config.ManagedRule(this, 'S3VersioningEnabled', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_VERSIONING_ENABLED,
      description: 'S3 buckets must have versioning enabled.',
    });

    new config.ManagedRule(this, 'S3BlockPublicAccess', {
      identifier: config.ManagedRuleIdentifiers.S3_ACCOUNT_LEVEL_PUBLIC_ACCESS_BLOCKS_PERIODIC,
      description: 'Account-level S3 Block Public Access settings must be enabled.',
    });
  }
}
